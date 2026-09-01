/**
 * Drives the McBopomofoEngine MacishType wrapper (in the style of MacishType's
 * Engines/ArrayEngine/index.test.mjs): stub the host-injected globals, then feed
 * synthetic KeyEvents whose mutator calls are recorded for assertions.
 *
 * Focus: keyboard-layout independence — under positional layouts (大千 / IBM)
 * composition follows event.code (physical position) so a Dvorak OS layout still
 * types Bopomofo; letter-mnemonic layouts (許氏 etc.) keep following event.key.
 */

import type { ConfirmEvent, KeyEvent } from "./macishtype_contract";

// Mutable stub (the real host's settings are read-only) so setLayout can switch
// the keyboard layout between tests.
const settings: Record<string, unknown> = {
  keyboardLayout: "Standard",
  candidateKeys: "123456789",
};

(globalThis as any).manifest = { settings, candidateWindow: {} };
// navigator may be a read-only built-in on newer Node; define it explicitly.
Object.defineProperty(globalThis, "navigator", {
  value: { languages: ["zh-TW"], language: "zh-TW", userAgent: "test" },
  configurable: true,
  writable: true,
});

(globalThis as any).localStorage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
};

(globalThis as any).addEventListener = () => {};

// Require AFTER the stubs above: macishtype.ts reads manifest / navigator /
// localStorage in top-level code on load.
type EngineModule = typeof import("./macishtype");
let McBopomofoEngine: EngineModule["default"];
beforeAll(() => {
  McBopomofoEngine = require("./macishtype").default;
});

type RecordedCall = { name: string; args: unknown[] };

interface FakeEvent extends Partial<KeyEvent>, Partial<ConfirmEvent> {
  calls: RecordedCall[];
  last(name: string): RecordedCall | undefined;
}

function makeEvent(props: Partial<KeyEvent & ConfirmEvent> = {}): FakeEvent {
  const calls: RecordedCall[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push({ name, args });
  return {
    key: "",
    code: "",
    keyIgnoringModifiers: "",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    location: 0,
    isComposing: false,
    isAssociating: false,
    markedText: "",
    stagedText: "",
    candidate: "",
    absoluteIndex: -1,
    payload: undefined,
    candidateWindow: { isVisible: false },
    getModifierState: () => false,
    updateMarkedText: record("updateMarkedText"),
    updateCandidates: record("updateCandidates"),
    commit: record("commit"),
    commitSelectedCandidate: record("commitSelectedCandidate"),
    commitCandidateAtIndex: record("commitCandidateAtIndex"),
    navigateCandidates: record("navigateCandidates"),
    resetContext: record("resetContext"),
    flushStaged: record("flushStaged"),
    enterAssociatedMode: record("enterAssociatedMode"),
    calls,
    last(name: string) {
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i].name === name) return calls[i];
      }
      return undefined;
    },
    ...props,
  } as any;
}

// W3C code for a QWERTY key, so a normal keystroke can be synthesized from a char.
const PUNCT_CODE: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "-": "Minus",
};
function codeForKey(key: string): string {
  if (PUNCT_CODE[key]) return PUNCT_CODE[key];
  if (/^[a-z]$/.test(key)) return "Key" + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return "Digit" + key;
  return "";
}

// The class's shared static engine; its snapshot is the cleanest state check.
function sharedEngine(): any {
  return (McBopomofoEngine as any).engine;
}

// Centralize the FakeEvent → host-type cast; nowhere else needs it.
function press(engine: InstanceType<EngineModule["default"]>, event: FakeEvent): boolean | void {
  return engine.handleKey(event as unknown as KeyEvent);
}
function confirmCandidate(engine: InstanceType<EngineModule["default"]>, event: FakeEvent): boolean | void {
  return engine.candidateConfirmed(event as unknown as ConfirmEvent);
}
function selectionChanged(engine: InstanceType<EngineModule["default"]>, event: FakeEvent): boolean | void {
  return engine.candidateSelectionChanged(event as unknown as ConfirmEvent);
}

// Set the layout in both places it matters: manifest (the wrapper's remap
// decision) and the facade (the actual char→Bopomofo map).
function setLayout(name: string): void {
  settings.keyboardLayout = name;
  sharedEngine().setKeyboardLayout(name);
}

// Type each char as a QWERTY keystroke (key + matching code); returns the last
// event for mutator inspection.
function compose(engine: InstanceType<EngineModule["default"]>, keys: string[]): FakeEvent {
  let event = makeEvent();
  for (const key of keys) {
    event = makeEvent({ key, code: codeForKey(key) });
    press(engine, event);
  }
  return event;
}

describe("McBopomofoEngine MacishType wrapper", () => {
  let engine: InstanceType<EngineModule["default"]>;

  beforeEach(() => {
    setLayout("Standard");
    engine = new McBopomofoEngine();
    engine.compositionEnded(); // reset the shared engine + per-instance state
  });

  test("starts (after reset) in the empty state", () => {
    expect(sharedEngine().snapshot()).toEqual({ kind: "empty" });
  });

  test("composes one Bopomofo and previews it as marked text", () => {
    // Standard layout: 'q' → ㄆ.
    const event = makeEvent({ key: "q", code: "KeyQ" });
    press(engine, event);
    expect(event.last("updateMarkedText")?.args[0]).toContain("ㄆ");
  });

  test("positional layout composes by physical position, not the produced char", () => {
    // Dvorak: the QWERTY-'q' position produces "'", but 大千 wants ㄆ.
    const event = makeEvent({ key: "'", code: "KeyQ" });
    press(engine, event);
    expect(event.last("updateMarkedText")?.args[0]).toContain("ㄆ");
    const snap = sharedEngine().snapshot();
    expect(snap.kind).toBe("inputting");
    expect(snap.composing).toContain("ㄆ");
  });

  test("positional layout maps a punctuation key by position too", () => {
    // Dvorak: the QWERTY-comma position produces "w"; 大千 comma → ㄝ. If the
    // wrapper followed the char it would wrongly compose ㄊ ('w' in 大千).
    const event = makeEvent({ key: "w", code: "Comma" });
    press(engine, event);
    expect(event.last("updateMarkedText")?.args[0]).toContain("ㄝ");
    expect(event.last("updateMarkedText")?.args[0]).not.toContain("ㄊ");
  });

  test("letter-mnemonic layout ignores the physical code and follows the char", () => {
    setLayout("Hsu");
    // Hsu is typed by letter: 'b' → ㄅ wherever the 'b' key physically sits.
    // The mismatched code "KeyN" must NOT pull in 'n' (which Hsu maps to ㄋ).
    const event = makeEvent({ key: "b", code: "KeyN" });
    press(engine, event);
    expect(event.last("updateMarkedText")?.args[0]).toContain("ㄅ");
    expect(event.last("updateMarkedText")?.args[0]).not.toContain("ㄋ");
  });

  test("a newly added positional layout also composes by physical position", () => {
    setLayout("GinYieh");
    // 精業 has no letter mnemonics at all: the QWERTY-'w' position is ㄆ. Under a
    // Dvorak OS layout that key produces ",", which 精業 maps to ㄝ.
    const event = makeEvent({ key: ",", code: "KeyW" });
    press(engine, event);
    expect(event.last("updateMarkedText")?.args[0]).toContain("ㄆ");
    expect(event.last("updateMarkedText")?.args[0]).not.toContain("ㄝ");
  });

  test("神通 is letter-mnemonic, so it follows the char", () => {
    setLayout("MITAC");
    // 神通 maps every consonant to its own Latin initial: 'b' → ㄅ wherever the
    // key sits. The mismatched code must not pull in 'n' (神通 'n' → ㄋ).
    const event = makeEvent({ key: "b", code: "KeyN" });
    press(engine, event);
    expect(event.last("updateMarkedText")?.args[0]).toContain("ㄅ");
    expect(event.last("updateMarkedText")?.args[0]).not.toContain("ㄋ");
  });

  test("Shift + a positional composition key does not compose Bopomofo", () => {
    // Shift+1 (code Digit1) must not become ㄅ — Shift disqualifies the bare
    // composition key, matching the produced-char behavior (Shift+1 → "!").
    const event = makeEvent({ key: "!", code: "Digit1", shiftKey: true });
    press(engine, event);
    const snap = sharedEngine().snapshot();
    if (snap.kind === "inputting") {
      expect(snap.composing).not.toContain("ㄅ");
    }
  });

  test("a complete syllable + Space opens a candidate list", () => {
    // 大千: s u 3 → ㄋㄧˇ.
    compose(engine, ["s", "u", "3"]);
    const space = makeEvent({ key: " ", code: "Space" });
    press(engine, space);
    expect(sharedEngine().snapshot().kind).toBe("choosing");
    const update = space.last("updateCandidates");
    expect(update).toBeDefined();
    expect((update?.args[0] as unknown[]).length).toBeGreaterThan(0);
  });

  test("confirming a candidate replaces the reading with the chosen character", () => {
    compose(engine, ["s", "u", "3"]);
    press(engine, makeEvent({ key: " ", code: "Space" }));
    expect(sharedEngine().snapshot().kind).toBe("choosing");

    // McBopomofo keeps composing after a pick (commit waits for Enter); the
    // chosen Han character replaces the raw Bopomofo in the buffer.
    const confirm = makeEvent({ candidate: "你", absoluteIndex: 0 });
    const handled = confirmCandidate(engine, confirm);
    expect(handled).toBe(true);
    expect(confirm.last("updateMarkedText")).toBeDefined();
    const snap = sharedEngine().snapshot();
    expect(snap.kind).toBe("inputting");
    expect(snap.composing.length).toBeGreaterThan(0);
    expect(snap.composing).not.toMatch(/[ㄅ-ㄩˇˊˋ˙]/); // no Bopomofo/tones left
  });

  // 大千 hk4 g4 so4 → ㄘㄜˋ ㄕˋ ㄋㄟˋ, walked as the phrase 測試 plus 內. Choosing 室內
  // for the last two readings breaks up 測試, so 測 becomes 策 — the mismatch a
  // spliced-in preview shows. Opens the window the way the host does:
  // updateCandidates, then a candidateSelectionChanged for the initial highlight.
  function openCandidatesForRoom(
    target: InstanceType<EngineModule["default"]>
  ): { roomIndex: number; initialIndex: number; initial: FakeEvent } {
    compose(target, ["h", "k", "4", "g", "4", "s", "o", "4"]);
    const opened = makeEvent({ key: "ArrowDown", code: "ArrowDown" });
    press(target, opened);
    expect(sharedEngine().snapshot().kind).toBe("choosing");
    const update = opened.last("updateCandidates");
    const candidates = update?.args[0] as { candidate: string }[];
    const initialIndex =
      (update?.args[1] as { initialHighlight?: number }).initialHighlight ?? 0;
    const roomIndex = candidates.findIndex((each) => each.candidate === "室內");
    expect(roomIndex).toBeGreaterThanOrEqual(0);

    const initial = makeEvent({
      candidate: candidates[initialIndex].candidate,
      absoluteIndex: initialIndex,
    });
    selectionChanged(target, initial);
    return { roomIndex, initialIndex, initial };
  }

  test("the highlighted-candidate preview is what confirming commits", () => {
    const { roomIndex } = openCandidatesForRoom(engine);

    const highlight = makeEvent({ candidate: "室內", absoluteIndex: roomIndex });
    selectionChanged(engine, highlight);
    const marked = highlight.last("updateMarkedText");
    expect(marked?.args[0]).toBe("策室內");
    expect((marked?.args[1] as { emphasis: unknown }).emphasis).toEqual({
      start: 1,
      end: 3,
    });

    const confirm = makeEvent({ candidate: "室內", absoluteIndex: roomIndex });
    confirmCandidate(engine, confirm);
    expect(confirm.last("updateMarkedText")?.args[0]).toBe(marked?.args[0]);
    expect(sharedEngine().snapshot().composing).toBe(marked?.args[0]);
  });

  test("the initial highlight is previewed too, before any navigation", () => {
    const { initialIndex, initial } = openCandidatesForRoom(engine);
    const marked = initial.last("updateMarkedText");
    expect(marked).toBeDefined();

    const confirm = makeEvent({ candidate: "", absoluteIndex: initialIndex });
    confirmCandidate(engine, confirm);
    expect(sharedEngine().snapshot().composing).toBe(marked?.args[0]);
  });

  // 大千 18 ␣ 1o4 2ji ␣ → ㄅㄚ ㄅㄟˋ ㄉㄨㄛ (巴貝多); Space applies tone 1. The
  // candidate list includes the flag emoji 🇧🇧 — four UTF-16 units, two code
  // points, one grapheme.
  function openCandidatesForFlag(
    target: InstanceType<EngineModule["default"]>
  ): { index: number } {
    const tone1 = () => press(target, makeEvent({ key: " ", code: "Space" }));
    compose(target, ["1", "8"]);
    tone1();
    compose(target, ["1", "o", "4", "2", "j", "i"]);
    tone1();
    const opened = makeEvent({ key: "ArrowDown", code: "ArrowDown" });
    press(target, opened);
    const candidates = opened.last("updateCandidates")?.args[0] as {
      candidate: string;
    }[];
    const index = candidates.findIndex((each) => each.candidate === "🇧🇧");
    expect(index).toBeGreaterThanOrEqual(0);
    return { index };
  }

  test("host indices count graphemes, not UTF-16 units", () => {
    const { index } = openCandidatesForFlag(engine);

    const highlight = makeEvent({ candidate: "🇧🇧", absoluteIndex: index });
    selectionChanged(engine, highlight);
    const marked = highlight.last("updateMarkedText");
    expect(marked?.args[0]).toBe("🇧🇧");
    expect(marked?.args[0]).toHaveLength(4); // UTF-16 units, for contrast
    expect(marked?.args[1]).toMatchObject({
      cursor: 1,
      emphasis: { start: 0, end: 1 },
    });

    const confirm = makeEvent({ candidate: "🇧🇧", absoluteIndex: index });
    confirmCandidate(engine, confirm);
    expect(confirm.last("updateMarkedText")?.args[1]).toMatchObject({
      cursor: 1,
    });
  });

  test("the candidate window anchors on a character, not a reading", () => {
    // Commit 🇧🇧 for all three readings, then type a fourth syllable (ㄋㄧˇ):
    // the buffer "🇧🇧你" holds two characters, while the new candidates sit at
    // reading 3. Anchoring on the reading index would point past the text.
    const { index } = openCandidatesForFlag(engine);
    confirmCandidate(engine, makeEvent({ candidate: "🇧🇧", absoluteIndex: index }));
    compose(engine, ["s", "u", "3"]);
    const reopened = makeEvent({ key: "ArrowDown", code: "ArrowDown" });
    press(engine, reopened);

    expect(reopened.last("updateMarkedText")?.args[0]).toBe("🇧🇧你");
    expect(reopened.last("updateCandidates")?.args[1]).toMatchObject({
      anchorAt: 1,
    });
  });

  test("compositionEnded clears an in-progress composition", () => {
    compose(engine, ["q"]);
    expect(sharedEngine().snapshot().kind).toBe("inputting");
    engine.compositionEnded();
    expect(sharedEngine().snapshot()).toEqual({ kind: "empty" });
  });
});
