import { describe, expect, it } from "vitest";
import {
  attribute,
  classify,
  foldListeners,
  friendlyName,
  parseBbIds,
  parseEnvironmentRows,
  parseListeners,
  parseProcessRows,
} from "../parse";

const LSOF = `COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    53949 dmitry   15u  IPv4 0x1      0t0  TCP 127.0.0.1:5173 (LISTEN)
Python  86708 dmitry    3u  IPv4 0x2      0t0  TCP *:8060 (LISTEN)
Python  86708 dmitry    4u  IPv6 0x3      0t0  TCP [::1]:8060 (LISTEN)
Code\\x20H  4242 dmitry   20u  IPv6 0x4      0t0  TCP [::]:9229 (LISTEN)`;

describe("listeners", () => {
  it("parses lsof rows and folds IPv4/IPv6 pairs to the widest bind", () => {
    const rows = foldListeners(parseListeners(LSOF));
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.port === 8060)?.address).toBe("0.0.0.0");
    expect(rows.find((row) => row.port === 9229)).toMatchObject({ processName: "Code H", address: "::" });
  });
});

describe("process facts", () => {
  it("reads pid, start time and command from ps lstart rows", () => {
    const rows = parseProcessRows(" 53949 Tue Nov 24 18:52:01 2026     node /x/node_modules/.bin/vite --host 127.0.0.1\n");
    const row = rows.get(53949);
    expect(row?.command).toBe("node /x/node_modules/.bin/vite --host 127.0.0.1");
    expect(row?.startedAt).toBe(Date.parse("Tue Nov 24 18:52:01 2026"));
  });

  it("takes BB ids from the environment after the command, last one wins", () => {
    const line = "95421 node server.mjs --note BB_THREAD_ID=thr_fake PATH=/bin BB_THREAD_ID=thr_kracmapryz BB_ENVIRONMENT_ID=env_uuexvm4775";
    expect(parseEnvironmentRows(line).get(95421)).toEqual({ threadId: "thr_kracmapryz", environmentId: "env_uuexvm4775" });
  });

  it("reads NUL-separated /proc environ", () => {
    expect(parseBbIds("HOME=/root\0BB_THREAD_ID=thr_abc\0BB_ENVIRONMENT_ID=env_x\0")).toEqual({ threadId: "thr_abc", environmentId: "env_x" });
    expect(parseBbIds("HOME=/root\0")).toEqual({ threadId: null, environmentId: null });
  });
});

describe("attribution and naming", () => {
  const roots = [
    { environmentId: "env_repo", path: "/w/repo" },
    { environmentId: "env_nested", path: "/w/repo/chain" },
  ];

  it("attributes a cwd to the longest matching root only", () => {
    expect(attribute("/w/repo/godot/build/web", roots)).toBe("env_repo");
    expect(attribute("/w/repo/chain/app", roots)).toBe("env_nested");
    expect(attribute("/w/repo-other", roots)).toBeNull();
  });

  it("names common dev servers", () => {
    expect(friendlyName("node /x/node_modules/.bin/vite --host 127.0.0.1", "node")).toBe("vite");
    expect(friendlyName("/opt/Python -m http.server 8060 --bind 0.0.0.0", "Python")).toBe("python http.server");
    expect(friendlyName("node server.mjs", "node")).toBe("server.mjs");
    expect(friendlyName("/usr/bin/java -classpath /x/maestro/lib/* maestro.cli.AppKt mcp", "java")).toBe("maestro mcp");
    expect(friendlyName("/usr/local/bin/mystery", "mystery")).toBe("mystery");
  });

  it("classifies agent tools and ephemeral loopback ports", () => {
    expect(classify("java maestro.cli.AppKt mcp", "127.0.0.1", 9999)).toBe("tool");
    expect(classify("node helper.js", "127.0.0.1", 61000)).toBe("internal");
    expect(classify("node vite", "127.0.0.1", 5173)).toBe("web");
    expect(classify("adb -L tcp:5037 fork-server server --reply-fd 4", "127.0.0.1", 5037)).toBe("tool");
  });
});
