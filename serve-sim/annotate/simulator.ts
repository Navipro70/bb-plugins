// What the server reads from the iOS Simulator: the booted devices, a
// screenshot (`xcrun simctl`), and the accessibility tree (`idb`).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Device, Snapshot, UiNode } from "./shared";

const run = promisify(execFile);
const TIMEOUT = 20_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/** The longest edge of the screenshot the panel gets, in pixels. */
const MAX_EDGE = 1600;
const MAX_NODES = 4000;

export const IDB_MISSING =
  "idb was not found, so elements cannot be picked. Install it with " +
  "`brew install facebook/fb/idb-companion` and `pipx install fb-idb`, " +
  "or set its path in the plugin's settings.";

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-5" → "iOS 26.5". */
export function runtimeName(key: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(key);
  if (!match) return key;
  const [, os, ...parts] = match;
  return `${os} ${parts.filter(Boolean).join(".")}`;
}

/** Booted simulators, from `xcrun simctl list devices booted -j`. */
export function parseDevices(json: string): Device[] {
  const data = JSON.parse(json) as {
    devices?: Record<string, { udid: string; name: string; state: string }[]>;
  };
  return Object.entries(data.devices ?? {}).flatMap(([runtime, devices]) =>
    devices
      .filter((device) => device.state === "Booted")
      .map((device) => ({
        udid: device.udid,
        name: device.name,
        runtime: runtimeName(runtime),
      })),
  );
}

export async function listDevices(): Promise<Device[]> {
  const { stdout } = await run(
    "xcrun",
    ["simctl", "list", "devices", "booted", "-j"],
    { timeout: TIMEOUT, maxBuffer: MAX_BUFFER },
  );
  return parseDevices(stdout);
}

interface IdbNode {
  type?: string | null;
  AXLabel?: string | null;
  AXUniqueId?: string | null;
  AXValue?: string | null;
  frame?: { x: number; y: number; width: number; height: number };
  children?: IdbNode[];
}

const text = (value: unknown, max = 400) =>
  typeof value === "string" && value.trim()
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : null;

/**
 * The tree `idb ui describe-all --nested --json` prints, cut to what the
 * panel and the agent read. Null when it has no application at its root.
 */
export function parseTree(json: string): UiNode | null {
  const data = JSON.parse(json) as IdbNode[] | IdbNode;
  const roots = Array.isArray(data) ? data : [data];
  let count = 0;
  const convert = (node: IdbNode): UiNode | null => {
    const frame = node.frame;
    if (!frame || ++count > MAX_NODES) return null;
    return {
      type: text(node.type, 100) ?? "Element",
      label: text(node.AXLabel),
      identifier: text(node.AXUniqueId),
      value: text(node.AXValue),
      frame: {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
      },
      children: (node.children ?? [])
        .slice(0, 500)
        .flatMap((child) => convert(child) ?? []),
    };
  };
  const root = roots.find((node) => node.type === "Application") ?? roots[0];
  return root ? convert(root) : null;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The idb binary: the setting, a usual install place, or the login shell's PATH. */
export async function findIdb(setting: string | undefined): Promise<string | null> {
  if (setting?.trim()) return (await exists(setting.trim())) ? setting.trim() : null;
  for (const dir of [
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    const path = join(dir, "idb");
    if (await exists(path)) return path;
  }
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const { stdout } = await run(shell, ["-lc", "command -v idb"], {
      timeout: TIMEOUT,
    });
    const path = stdout.trim().split("\n").pop();
    return path && (await exists(path)) ? path : null;
  } catch {
    return null;
  }
}

async function screenshot(udid: string) {
  const base = join(tmpdir(), `sim-annotate-${randomUUID()}`);
  const png = `${base}.png`;
  const jpg = `${base}.jpg`;
  try {
    await run("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", png], {
      timeout: TIMEOUT,
    });
    await run(
      "sips",
      ["-Z", String(MAX_EDGE), "-s", "format", "jpeg", "-s", "formatOptions", "80", png, "--out", jpg],
      { timeout: TIMEOUT },
    );
    const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", jpg], {
      timeout: TIMEOUT,
    });
    const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
    if (!width || !height) throw new Error("Could not read the screenshot's size.");
    const base64 = (await readFile(jpg)).toString("base64");
    return { base64, width, height };
  } finally {
    await Promise.all([rm(png, { force: true }), rm(jpg, { force: true })]);
  }
}

async function tree(idb: string | null, udid: string) {
  if (!idb) return { tree: null, error: IDB_MISSING };
  try {
    const { stdout } = await run(
      idb,
      ["ui", "describe-all", "--udid", udid, "--nested", "--json"],
      { timeout: TIMEOUT, maxBuffer: MAX_BUFFER },
    );
    const root = parseTree(stdout);
    return root
      ? { tree: root, error: null }
      : { tree: null, error: "The simulator reported no app on screen." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tree: null,
      error: `idb could not read the screen: ${message.split("\n")[0]}`,
    };
  }
}

/** A screenshot and the tree, taken together so they show the same screen. */
export async function takeSnapshot(device: Device, idb: string | null): Promise<Snapshot> {
  const [image, ui] = await Promise.all([
    screenshot(device.udid),
    tree(idb, device.udid),
  ]);
  return {
    takenAt: Date.now(),
    device,
    image,
    screen: ui.tree
      ? { width: ui.tree.frame.width, height: ui.tree.frame.height }
      : null,
    app: ui.tree?.label ?? null,
    tree: ui.tree,
    treeError: ui.error,
  };
}
