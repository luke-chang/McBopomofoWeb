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
    message: null,
    candidateWindow: { isVisible: false },
    getModifierState: () => false,
    updateMarkedText: record("updateMarkedText"),
    updateCandidates: record("updateCandidates"),
    updateMessage: record("updateMessage"),
    commit: record("commit"),
    commitSelectedCandidate: record("commitSelectedCandidate"),
    commitCandidateAtIndex: record("commitCandidateAtIndex"),
    navigateCandidates: record("navigateCandidates"),
    resetContext: record("resetContext"),
    flushStaged: record("flushStaged"),
    enterAssociatedMode: record("enterAssociatedMode"),
    beep: record("beep"),
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

  // 大千 vu04 y94 → ㄒㄧㄢˋ ㄗㄞˋ (現在), whose candidates include the
  // MACRO@TIME_NOW_SHORT expansion: two readings rendered as a clock string, so
  // no caret position inside it can show which syllable the cursor is on.
  test("the cursor-between-syllables tooltip surfaces as a message", () => {
    compose(engine, ["v", "u", "0", "4", "y", "9", "4"]);
    const opened = makeEvent({ key: "ArrowDown", code: "ArrowDown" });
    press(engine, opened);
    const candidates = opened.last("updateCandidates")?.args[0] as {
      candidate: string;
    }[];
    const macroIndex = candidates.findIndex((each) => /\d/.test(each.candidate));
    expect(macroIndex).toBeGreaterThanOrEqual(0);
    confirmCandidate(
      engine,
      makeEvent({
        candidate: candidates[macroIndex].candidate,
        absoluteIndex: macroIndex,
      })
    );

    // Cursor lands between the two readings: tooltip on.
    const left = makeEvent({ key: "ArrowLeft", code: "ArrowLeft" });
    press(engine, left);
    expect(left.last("updateMessage")?.args[0]).toBe(
      "游標正在 ㄒㄧㄢˋ 與 ㄗㄞˋ 之間"
    );

    // Cursor leaves the node: the updateCandidates([]) that every inputting
    // update emits is what retires the message, so no updateMessage follows.
    const left2 = makeEvent({ key: "ArrowLeft", code: "ArrowLeft" });
    press(engine, left2);
    expect(left2.last("updateCandidates")?.args[0]).toEqual([]);
    expect(left2.last("updateMessage")).toBeUndefined();
  });

  // Shift+Left from 大千 hk4 g4 (ㄘㄜˋ ㄕˋ → 測試) marks the last syllable: one
  // reading, below the two-syllable minimum, so the status text is fixed
  // whatever the dictionaries hold.
  function markLastSyllable(
    target: InstanceType<EngineModule["default"]>
  ): FakeEvent {
    compose(target, ["h", "k", "4", "g", "4"]);
    const mark = makeEvent({
      key: "ArrowLeft",
      code: "ArrowLeft",
      shiftKey: true,
    });
    press(target, mark);
    expect(sharedEngine().snapshot().kind).toBe("marking");
    return mark;
  }

  test("the Marking status line is a message, not a one-item candidate list", () => {
    const mark = markLastSyllable(engine);
    expect(mark.last("updateMessage")?.args[0]).toBe("最少需要 2 字元");
    // Anchored on the mark, and emitted after the marked text it indexes into.
    expect(mark.last("updateMessage")?.args[1]).toMatchObject({ anchorAt: 1 });
    expect(mark.calls.map((each) => each.name)).toEqual([
      "updateMarkedText",
      "updateMessage",
    ]);
  });

  test("leaving Marking retires the status message", () => {
    markLastSyllable(engine);
    const escape = makeEvent({ key: "Escape", code: "Escape" });
    press(engine, escape);
    expect(sharedEngine().snapshot().kind).toBe("inputting");
    // updateCandidates([]) is the only thing that retires a message: the
    // wrapper never calls updateMessage("").
    expect(escape.last("updateCandidates")?.args[0]).toEqual([]);
    expect(escape.last("updateMessage")).toBeUndefined();
  });

  test("`?` while marking is swallowed, keeping the composition alive", () => {
    markLastSyllable(engine);
    // KeyHandler would turn this into a dictionary-lookup menu, which the
    // facade reports as empty — _apply would then resetContext the buffer away.
    const question = makeEvent({ key: "?", code: "Slash", shiftKey: true });
    expect(press(engine, question)).toBe(true);
    expect(question.calls).toEqual([]);
    expect(sharedEngine().snapshot().kind).toBe("marking");
  });

  test("Marking Enter saves through the facade, not the host commit path", () => {
    markLastSyllable(engine);
    const enter = makeEvent({ key: "Enter", code: "Enter" });
    press(engine, enter);
    // A message can't be committed, so nothing routes through the host.
    expect(enter.last("commitSelectedCandidate")).toBeUndefined();
    // One reading is unacceptable: the facade stays in Marking on Return, and
    // the Esc fallback is what gets us back to inputting.
    expect(sharedEngine().snapshot().kind).toBe("inputting");
  });

  // Highlights 室內 in the candidate list and presses the physical "=" key.
  function pressPlusOnRoom(
    target: InstanceType<EngineModule["default"]>
  ): { roomIndex: number; reading: string; plus: FakeEvent } {
    const { roomIndex } = openCandidatesForRoom(target);
    selectionChanged(target, makeEvent({ candidate: "室內", absoluteIndex: roomIndex }));
    const reading = sharedEngine().snapshot().candidates[roomIndex].reading;
    const plus = makeEvent({ key: "=", code: "Equal" });
    press(target, plus);
    return { roomIndex, reading, plus };
  }

  test("the + / - confirmation is a message; Escape restores the candidate list", () => {
    const { roomIndex, reading, plus } = pressPlusOnRoom(engine);
    expect(plus.last("updateMessage")?.args[0]).toBe("增加「室內」的權重  ↵");
    expect(plus.last("updateCandidates")).toBeUndefined();

    const escape = makeEvent({ key: "Escape", code: "Escape" });
    press(engine, escape);
    // Back to the list under the highlight the user left it on, with nothing
    // written to the user dictionary.
    expect(escape.last("updateCandidates")?.args[1]).toMatchObject({
      initialHighlight: roomIndex,
    });
    expect(sharedEngine().checkPhraseStatus("add", reading, "室內")).toBe("ok");
  });

  test("Enter on the + confirmation adds the phrase and restores the list", () => {
    const { roomIndex, reading, plus } = pressPlusOnRoom(engine);
    expect(plus.last("updateMessage")).toBeDefined();

    const enter = makeEvent({ key: "Enter", code: "Enter" });
    press(engine, enter);
    expect(enter.last("commitSelectedCandidate")).toBeUndefined();
    expect(sharedEngine().checkPhraseStatus("add", reading, "室內")).toBe("exists");
    expect(enter.last("updateCandidates")?.args[1]).toMatchObject({
      initialHighlight: roomIndex,
    });
  });

  // 大千 s u 3 → ㄋㄧˇ, then Space opens its candidate list.
  function openCandidatesForNi(target: InstanceType<EngineModule["default"]>): void {
    compose(target, ["s", "u", "3"]);
    press(target, makeEvent({ key: " ", code: "Space" }));
    expect(sharedEngine().snapshot().kind).toBe("choosing");
  }

  // A visible window on a short page: three candidates under nine labels.
  // `slot` is where the host places the key among the labels, null for none.
  function shortPage(slot: number | null): Partial<KeyEvent> {
    return {
      candidateWindow: {
        isVisible: true,
        pageStart: 9,
        pageEnd: 12,
        candidateIndex: () => slot,
      } as unknown as KeyEvent["candidateWindow"],
    };
  }

  describe("an index label with no candidate behind it", () => {
    test("a digit label beeps and keeps the candidate window", () => {
      openCandidatesForNi(engine);
      const five = makeEvent({ key: "5", code: "Digit5", ...shortPage(4) });
      expect(press(engine, five)).toBe(true);
      expect(five.calls.map((call) => call.name)).toEqual(["beep"]);
      expect(sharedEngine().snapshot().kind).toBe("choosing");
    });

    test("a letter label beeps instead of committing the highlighted candidate", () => {
      openCandidatesForNi(engine);
      const k = makeEvent({ key: "k", code: "KeyK", ...shortPage(7) });
      expect(press(engine, k)).toBe(true);
      expect(k.calls.map((call) => call.name)).toEqual(["beep"]);
      expect(sharedEngine().snapshot().kind).toBe("choosing");
    });

    test("a key that is no label still commits the highlight to start a syllable", () => {
      openCandidatesForNi(engine);
      const q = makeEvent({ key: "q", code: "KeyQ", ...shortPage(null) });
      expect(press(engine, q)).toBe(true);
      expect(q.last("commitSelectedCandidate")).toBeDefined();
      expect(q.last("beep")).toBeUndefined();
    });
  });

  // Caps Lock suspends Bopomofo, as McBopomofo does on macOS: a printable key
  // ends the composition and reaches the app as typed.
  describe("Caps Lock", () => {
    // The case is the platform's own; shiftKey stays false.
    function capsLock(
      key: string,
      code: string,
      props: Partial<KeyEvent> = {},
    ): FakeEvent {
      return makeEvent({
        key,
        code,
        getModifierState: (state: string) => state === "CapsLock",
        ...props,
      });
    }

    test.each(["Standard", "ETen"])(
      "%s passes a letter straight to the app when idle",
      (layout) => {
        setLayout(layout);
        const a = capsLock("A", "KeyA");
        expect(press(engine, a)).toBe(false);
        expect(a.calls).toEqual([]);
        expect(sharedEngine().snapshot()).toEqual({ kind: "empty" });
      },
    );

    test("a digit composition key passes through too", () => {
      // 大千 '1' is ㄅ; Caps Lock suspends every composition key, not just letters.
      const one = capsLock("1", "Digit1");
      expect(press(engine, one)).toBe(false);
      expect(sharedEngine().snapshot()).toEqual({ kind: "empty" });
    });

    test("a letter commits the staged text and ends the composition", () => {
      // 你 walked, ㄆ still a partial reading — kept out of staged by _apply.
      const last = compose(engine, ["s", "u", "3", "q"]);
      expect(last.last("updateMarkedText")?.args[1]).toMatchObject({ staged: 1 });

      const a = capsLock("A", "KeyA");
      expect(press(engine, a)).toBe(false);
      expect(a.calls).toEqual([
        { name: "flushStaged", args: [] },
        { name: "resetContext", args: [] },
      ]);
      expect(sharedEngine().snapshot()).toEqual({ kind: "empty" });
    });

    test("a letter while choosing ends the composition and its window", () => {
      openCandidatesForNi(engine);
      const a = capsLock("A", "KeyA", shortPage(null));
      expect(press(engine, a)).toBe(false);
      expect(a.calls.map((call) => call.name)).toEqual([
        "flushStaged",
        "resetContext",
      ]);
      expect(sharedEngine().snapshot()).toEqual({ kind: "empty" });
    });

    test("an index label with no candidate still beeps", () => {
      openCandidatesForNi(engine);
      const five = capsLock("5", "Digit5", shortPage(4));
      expect(press(engine, five)).toBe(true);
      expect(five.calls.map((call) => call.name)).toEqual(["beep"]);
      expect(sharedEngine().snapshot().kind).toBe("choosing");
    });

    test("Backspace still edits the composition", () => {
      compose(engine, ["s", "u", "3", "q"]);
      const backspace = capsLock("Backspace", "Backspace");
      expect(press(engine, backspace)).toBe(true);
      expect(backspace.last("flushStaged")).toBeUndefined();
      const snap = sharedEngine().snapshot();
      expect(snap.kind).toBe("inputting");
      expect(snap.readingLength).toBe(0);
    });
  });
});
