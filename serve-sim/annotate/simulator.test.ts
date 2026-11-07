import { describe, expect, it } from "vitest";
import { parseDevices, parseTree, runtimeName } from "./simulator";

describe("runtimeName", () => {
  it("reads simctl's runtime keys", () => {
    expect(runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-26-5")).toBe("iOS 26.5");
    expect(runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-18-3-1")).toBe("iOS 18.3.1");
    expect(runtimeName("something")).toBe("something");
  });
});

describe("parseDevices", () => {
  it("lists only booted devices", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          { udid: "8FCB4721-3521-45A1-B9E2-53ED12EC9B70", name: "iPhone 17 Pro", state: "Booted" },
          { udid: "11111111-2222-3333-4444-555555555555", name: "iPad", state: "Shutdown" },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-3": [],
      },
    });
    expect(parseDevices(json)).toEqual([
      { udid: "8FCB4721-3521-45A1-B9E2-53ED12EC9B70", name: "iPhone 17 Pro", runtime: "iOS 26.5" },
    ]);
  });
});

describe("parseTree", () => {
  it("keeps the fields the panel and the agent read", () => {
    const json = JSON.stringify([
      {
        type: "Application",
        AXLabel: "Nimbus",
        AXUniqueId: null,
        frame: { x: 0, y: 0, width: 402, height: 874 },
        role: "AXApplication",
        children: [
          {
            type: "Button",
            AXLabel: "  Buy\n Pro ",
            AXUniqueId: "buy-pro",
            AXValue: "",
            frame: { x: 16, y: 380, width: 370, height: 52 },
            children: [],
          },
          { type: "Other", AXLabel: null },
        ],
      },
    ]);
    expect(parseTree(json)).toEqual({
      type: "Application",
      label: "Nimbus",
      identifier: null,
      value: null,
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        {
          type: "Button",
          label: "Buy Pro",
          identifier: "buy-pro",
          value: null,
          frame: { x: 16, y: 380, width: 370, height: 52 },
          children: [],
        },
      ],
    });
  });

  it("returns null for an empty tree", () => {
    expect(parseTree("[]")).toBeNull();
  });
});
