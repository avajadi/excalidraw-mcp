import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  Sidebar,
  restoreElements,
  CaptureUpdateAction,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  ExcalidrawImperativeAPI,
  AppState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** Scene id to view, from `?scene=<name>` (matches the MCP filename). */
const SCENE_ID = new URLSearchParams(location.search).get("scene") ?? "scene";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${
  location.host
}/ws?scene=${encodeURIComponent(SCENE_ID)}`;

const SAVE_DEBOUNCE_MS = 400;

/** Normalize a name the way the server does, so ids always match. */
function toSceneId(name: string): string {
  const base = name.trim().replace(/^.*[\\/]/, "");
  return base.endsWith(".excalidraw") ? base : `${base}.excalidraw`;
}

/** Stable signature of the elements that matters — changes only on real edits,
 *  not on selection/pointer moves, so we don't echo remote updates back. */
function signature(elements: readonly ExcalidrawElement[]): string {
  return elements.map((e) => `${e.id}:${e.version}:${e.isDeleted ? 1 : 0}`).join(",");
}

interface SceneRef {
  id: string;
  name: string;
}

function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bgRef = useRef<string>("#ffffff");
  // Scene currently shown; changes when the relay activates a scene Claude drew
  // or when the user picks one from the scene picker.
  const sceneIdRef = useRef<string>(SCENE_ID);
  const [currentScene, setCurrentScene] = useState<string>(toSceneId(SCENE_ID));
  const [scenes, setScenes] = useState<SceneRef[]>([]);
  // When on, Claude's pushes drag this tab to whatever scene it's drawing.
  // When off, the tab stays on the scene you picked. Mirrored into a ref so the
  // WebSocket handler (a stable closure) always sees the latest value.
  const [follow, setFollow] = useState<boolean>(true);
  const followRef = useRef(follow);
  followRef.current = follow;
  // The scenes sidebar is docked on the left by default.
  const [docked, setDocked] = useState<boolean>(true);
  // Signature of the scene we last received or sent — the echo-loop guard.
  const lastSigRef = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Pull the list of scenes the user can open from the relay. */
  const fetchScenes = useCallback(async () => {
    try {
      const res = await fetch("/scenes");
      if (!res.ok) return;
      setScenes((await res.json()) as SceneRef[]);
    } catch (err) {
      console.error("Failed to list scenes:", err);
    }
  }, []);

  /** Open a scene to view/edit. `isNew` starts a blank scene created on first edit. */
  const switchScene = useCallback(
    (name: string, opts: { isNew?: boolean } = {}) => {
      const id = toSceneId(name);
      if (!opts.isNew && id === sceneIdRef.current) return;
      sceneIdRef.current = id;
      setCurrentScene(id);

      const u = new URL(location.href);
      u.searchParams.set("scene", id);
      history.replaceState(null, "", u); // keep the URL accurate on reload
      document.title = `${id.replace(/\.excalidraw$/, "")} — Excalidraw live`;

      if (opts.isNew) {
        // Blank canvas; the scene file is created on the first edit.
        lastSigRef.current = "";
        api?.updateScene({
          elements: [],
          appState: { viewBackgroundColor: bgRef.current },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        setScenes((s) =>
          s.some((x) => x.id === id)
            ? s
            : [...s, { id, name: id.replace(/\.excalidraw$/, "") }].sort((a, b) =>
                a.id.localeCompare(b.id),
              ),
        );
        return;
      }
      // Ask the relay for this scene; its reply lands in the onmessage handler.
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "subscribe", id }));
      }
    },
    [api],
  );

  // --- relay → canvas -------------------------------------------------------
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void fetchScenes();

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type !== "scene" || !msg.scene) return;

          // The relay activates a scene on every tab when Claude draws it.
          if (msg.activate && msg.id && msg.id !== sceneIdRef.current) {
            if (!followRef.current) {
              // Following is off and we're parked on another scene: ignore the
              // push, and re-assert our scene so the relay keeps routing its
              // live updates to us (activate repointed us on the server).
              ws.send(JSON.stringify({ type: "subscribe", id: sceneIdRef.current }));
              return;
            }
            sceneIdRef.current = msg.id;
            setCurrentScene(msg.id);
            const u = new URL(location.href);
            u.searchParams.set("scene", msg.id);
            history.replaceState(null, "", u); // keep the URL accurate on reload
            document.title = `${msg.id.replace(/\.excalidraw$/, "")} — Excalidraw live`;
            // Tell the relay this tab now shows that scene (it's the source of
            // truth for "current scene") so the MCP can act on it.
            ws.send(JSON.stringify({ type: "viewing", id: msg.id }));
            void fetchScenes(); // a new scene may have appeared
          }

          // Ignore stray scene messages meant for a scene we're not viewing.
          if (msg.id && msg.id !== sceneIdRef.current) return;

          const scene = msg.scene;
          const elements = restoreElements(scene.elements ?? [], null);
          lastSigRef.current = signature(elements);
          if (scene.appState?.viewBackgroundColor) {
            bgRef.current = scene.appState.viewBackgroundColor;
          }
          api.updateScene({
            elements,
            appState: { viewBackgroundColor: bgRef.current },
            // Don't pollute the local undo stack with remote pushes; also keeps
            // the current viewport/selection intact.
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        } catch (err) {
          console.error("Bad message from relay:", err);
        }
      };
      ws.onclose = () => {
        if (alive) setTimeout(connect, 1000); // reconnect
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      alive = false;
      wsRef.current?.close();
    };
  }, [api, fetchScenes]);

  // --- canvas → relay (debounced) ------------------------------------------
  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
      const sig = signature(elements);
      if (sig === lastSigRef.current) return; // nothing meaningful changed
      if (appState.viewBackgroundColor) bgRef.current = appState.viewBackgroundColor;

      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        lastSigRef.current = sig;
        ws.send(
          JSON.stringify({
            type: "update",
            id: sceneIdRef.current,
            scene: {
              type: "excalidraw",
              version: 2,
              source: "excalidraw-mcp-web",
              elements,
              appState: { viewBackgroundColor: bgRef.current },
              files: {},
            },
          }),
        );
        void fetchScenes(); // a first edit may have created a new scene file
      }, SAVE_DEBOUNCE_MS);
    },
    [fetchScenes],
  );

  // Always include the open scene, even if it has not been saved to a file yet.
  const options = scenes.some((s) => s.id === currentScene)
    ? scenes
    : [...scenes, { id: currentScene, name: currentScene.replace(/\.excalidraw$/, "") }];

  const newScene = () => {
    const name = prompt("New scene name:");
    if (name && name.trim()) switchScene(name.trim(), { isNew: true });
  };

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 10px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    font: "inherit",
    fontSize: 14,
    color: "inherit",
    background: active ? "var(--color-primary-light, #e0dfff)" : "transparent",
    fontWeight: active ? 600 : 400,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });

  // The "Scenes" sidebar, docked on the left like the Excalidraw dashboard.
  const scenesSidebar = (
    <Sidebar name="scenes" docked={docked} onDock={setDocked}>
      <Sidebar.Header>
        <div style={{ fontWeight: 600, fontSize: 16, padding: "0 4px", flex: 1 }}>Scenes</div>
      </Sidebar.Header>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, padding: 8, gap: 8 }}>
        <button
          onClick={newScene}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px dashed var(--default-border-color, #ccc)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
            fontSize: 14,
          }}
        >
          + New scene
        </button>
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {options.map((s) => (
            <button
              key={s.id}
              onClick={() => switchScene(s.id)}
              title={s.name}
              style={rowStyle(s.id === currentScene)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <label
          title="When on, this tab jumps to whatever scene Claude is drawing. Turn off to stay on the scene you picked."
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 10px",
            borderTop: "1px solid var(--default-border-color, #ccc)",
            cursor: "pointer",
            font: "inherit",
            fontSize: 14,
          }}
        >
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow Claude
        </label>
      </div>
    </Sidebar>
  );

  // Top-right button to reopen the sidebar if the user closes it.
  const renderTopRight = () => (
    <button
      title="Scenes"
      onClick={() => api?.toggleSidebar({ name: "scenes" })}
      style={{
        height: 36,
        padding: "0 10px",
        borderRadius: 8,
        border: "1px solid var(--default-border-color, #ccc)",
        background: "var(--island-bg-color, #fff)",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      Scenes
    </button>
  );

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      onChange={onChange}
      initialData={{ appState: { openSidebar: { name: "scenes" } } }}
      renderTopRightUI={renderTopRight}
    >
      {scenesSidebar}
    </Excalidraw>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);