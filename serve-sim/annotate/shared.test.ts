import { describe, expect, it } from "vitest";
import {
  PROVIDER,
  climb,
  formatNote,
  hitTest,
  noteIds,
  noteSchema,
  pillLabel,
  withoutNote,
  type Note,
  type UiNode,
} from "./shared";

const node = (
  type: string,
  frame: [number, number, number, number],
  extra: Partial<UiNode> = {},
): UiNode => ({
  type,
  label: null,
  identifier: null,
  value: null,
  frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] },
  children: [],
  ...extra,
});

// A full-screen group over a list, as UIKit and React Native report them.
const buy = node("Button", [16, 380, 370, 52], { label: "Buy Pro", identifier: "buy-pro" });
const card = node("Other", [8, 300, 386, 200], { children: [buy] });
const cardTwin = node("Other", [8, 300, 386, 200], { children: [card] });
const toolbar = node("Group", [0, 788, 402, 86], { label: "Toolbar" });
const overlay = node("Group", [0, 0, 402, 874], { children: [cardTwin] });
const root = node("Application", [0, 0, 402, 874], {
  label: "Nimbus",
  children: [overlay, toolbar],
});

describe("hitTest", () => {
  it("finds the smallest element under the point, with its ancestors", () => {
    expect(hitTest(root, 100, 400)).toEqual([root, overlay, cardTwin, card, buy]);
  });

  it("prefers a small sibling over a full-screen group", () => {
    expect(hitTest(root, 100, 800).at(-1)).toBe(toolbar);
  });

  it("returns nothing off the screen", () => {
    expect(hitTest(root, 500, 10)).toEqual([]);
  });
});

describe("climb", () => {
  const path = [root, overlay, cardTwin, card, buy];

  it("goes to the parent, then skips its twin with the same frame", () => {
    expect(climb(path, 1).at(-1)).toBe(card);
    expect(climb(path, 2).at(-1)).toBe(overlay);
  });

  it("stops below the application", () => {
    expect(climb(path, 10).at(-1)).toBe(overlay);
  });

  it("keeps the element at level 0", () => {
    expect(climb(path, 0)).toEqual(path);
  });
});

const note: Note = noteSchema.parse({
  id: "nabc1234",
  number: 1,
  comment: "Make it green\nand bigger",
  device: {
    udid: "8FCB4721-3521-45A1-B9E2-53ED12EC9B70",
    name: "iPhone 17 Pro",
    runtime: "iOS 26.5",
  },
  app: "Nimbus",
  element: {
    type: "Button",
    label: "Buy Pro",
    identifier: "buy-pro",
    value: null,
    frame: { x: 16, y: 380.33333, width: 370, height: 52 },
    ancestors: ['Application "Nimbus"', "Group"],
    screen: { width: 402, height: 874 },
  },
});

describe("formatNote", () => {
  it("gives the agent the comment, the testID, and the frame", () => {
    const text = formatNote(note);
    expect(text).toContain("# Simulator note 1");
    expect(text).toContain("> Make it green\n> and bigger");
    expect(text).toContain('- Element: Button "Buy Pro"');
    expect(text).toContain("`buy-pro`");
    expect(text).toContain("`testID`");
    expect(text).toContain("370×52 pt at (16, 380.3), on a 402×874 pt screen");
    expect(text).toContain('Application "Nimbus" › Group');
  });

  it("says when there is no testID", () => {
    const text = formatNote({ ...note, element: { ...note.element, identifier: null } });
    expect(text).toContain("Identifier: none");
  });
});

describe("pills", () => {
  it("label the note by its text", () => {
    expect(pillLabel(note)).toBe("1 · Buy Pro");
  });

  const pill = (id: string, from: number, to: number) => ({
    kind: "plugin",
    provider: PROVIDER,
    id,
    label: id,
    from,
    to,
  });
  const draft = {
    text: "AA BB fix",
    mentions: [pill("na", 0, 2), pill("nb", 3, 5), { kind: "thread", from: 6, to: 9 }],
  };

  it("list note ids in order", () => {
    expect(noteIds(draft)).toEqual(["na", "nb"]);
  });

  it("remove one pill and shift the ones after it", () => {
    const next = withoutNote(draft, "na");
    expect(next.text).toBe("BB fix");
    expect(next.mentions.map((m) => [m.from, m.to])).toEqual([
      [0, 2],
      [3, 6],
    ]);
  });
});
