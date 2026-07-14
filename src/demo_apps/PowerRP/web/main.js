import "../../../styles/theme.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { deserialize, foldState } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { paintScene, fitSlideView } from "../render/compositor.js";

/**
 * Headless render hook for cli/render.js (puppeteer calls this): renders one
 * frame of a document at (slide, alpha) to width×height and returns a PNG
 * data URL. Same compositor code path as the live editor — no divergence.
 */
window.__powerrp_render = function (docJson, { slide = 0, alpha = 1, width = 1280, height = 720 } = {}) {
  const doc = typeof docJson === "string" ? deserialize(docJson) : docJson;
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const view = fitSlideView(doc.meta, width, height, 1);
  ctx.fillStyle = doc.meta.background ?? "#ffffff";
  ctx.fillRect(0, 0, width, height);
  paintScene(ctx, doc, { slideIndex: slide, alpha, registry, view });
  return canvas.toDataURL("image/png");
};

// `?cli=1` skips mounting the editor UI — the page then exists only to host
// __powerrp_render for the CLI (faster, and headless-safe).
if (!new URLSearchParams(location.search).has("cli")) {
  mount(App, { target: document.getElementById("app") });
}
