// State-in/state-out facade over KeyHandler/WebLanguageModel/InputState for
// hosts that own their own candidate UI (and so can't use InputController).

import { BopomofoKeyboardLayout } from "./Mandarin";
import { inputMacroController } from "./McBopomofo/InputMacro";
import {
  ChoosingCandidate,
  ChoosingPunctuationList,
  Committing,
  Empty,
  EmptyIgnoringPrevious,
  InputState,
  Inputting,
  Marking,
} from "./McBopomofo/InputState";
import { Key, KeyName } from "./McBopomofo/Key";
import { KeyHandler } from "./McBopomofo/KeyHandler";
import { KeyMapping } from "./McBopomofo/KeyMapping";
import { LocalizedStrings } from "./McBopomofo/LocalizedStrings";
import { webData } from "./McBopomofo/WebData";
import { WebLanguageModel } from "./McBopomofo/WebLanguageModel";

export type KeyboardLayoutName =
  | "Standard"
  | "ETen"
  | "Hsu"
  | "ETen26"
  | "HanyuPinyin"
  | "IBM"
  | "Su"
  | "GinYieh"
  | "MITAC";

export type Snapshot =
  | { kind: "empty" }
  | {
      kind: "inputting";
      composing: string;
      cursor: number;
      tooltip: string;
      // Length of the trailing in-progress bopomofo at the cursor; 0
      // between completed syllables. Splits `composing` at
      // `cursor - readingLength` into walked text + raw bopomofo.
      readingLength: number;
    }
  | {
      kind: "choosing";
      // "punctuation" = the menu opened by backtick. The host distinguishes
      // so it can lock further typing — accidental keys would otherwise
      // commit a symbol via the deferred-key flow.
      mode: "candidates" | "punctuation";
      composing: string;
      cursor: number;
      // Character offset in `composing` where the leftmost candidate's segment
      // starts — where a host anchors its candidate window. Not the same as a
      // candidate's `spanIndex`, which counts readings.
      anchorOffset: number;
      candidates: Array<{
        reading: string;
        value: string;
        displayedText: string;
        spanIndex: number;
      }>;
    }
  | {
      kind: "marking";
      composing: string;
      cursor: number;
      // Emphasis range over `composing` (= head + markedText + tail).
      markStart: number;
      markEnd: number;
      // Derived from KeyHandler's `acceptable` + reading-syllable count so the
      // host can render its own short status text without parsing the
      // localized tooltip.
      //   "ok"       → can be added
      //   "exists"   → already in the user dictionary
      //   "tooShort" → marked span < 2 syllables
      //   "tooLong"  → marked span > 8 syllables
      status: "ok" | "exists" | "tooShort" | "tooLong";
    };

/**
 * What the composing buffer would look like with a candidate selected;
 * `emphasis` is the range the candidate occupies within `text`. Offsets are
 * plain JS string indices (UTF-16 code units).
 */
export interface CandidatePreview {
  text: string;
  cursor: number;
  emphasis: { start: number; end: number };
}

export interface PushResult {
  snapshot: Snapshot;
  committed: string;
  handled: boolean;
}

function keyboardLayoutFor(name: KeyboardLayoutName): BopomofoKeyboardLayout {
  switch (name) {
    case "ETen":
      return BopomofoKeyboardLayout.ETenLayout;
    case "Hsu":
      return BopomofoKeyboardLayout.HsuLayout;
    case "ETen26":
      return BopomofoKeyboardLayout.ETen26Layout;
    case "HanyuPinyin":
      return BopomofoKeyboardLayout.HanyuPinyinLayout;
    case "IBM":
      return BopomofoKeyboardLayout.IBMLayout;
    case "Su":
      return BopomofoKeyboardLayout.SuLayout;
    case "GinYieh":
      return BopomofoKeyboardLayout.GinYiehLayout;
    case "MITAC":
      return BopomofoKeyboardLayout.MitacLayout;
    default:
      return BopomofoKeyboardLayout.StandardLayout;
  }
}

export class MacishMcBopomofo {
  private model: WebLanguageModel;
  private handler: KeyHandler;
  private state: InputState = new Empty();

  constructor(opts: { keyboardLayout?: KeyboardLayoutName; languageCode?: string } = {}) {
    this.model = new WebLanguageModel(webData);
    // Resolves MACRO@ tokens (date / weekday / year / ...) at candidate lookup.
    this.model.setMacroConverter((input) => inputMacroController.handle(input));
    this.handler = new KeyHandler(this.model, new LocalizedStrings());
    this.handler.keyboardLayout = keyboardLayoutFor(opts.keyboardLayout ?? "Standard");
    // macOS-style: after typing a tone mark, pressing another tone replaces it
    // instead of starting a new syllable. Matches Apple TCIM behavior.
    // KeyHandler applies this to the Standard layout only — on the others a
    // tone key can be part of a syllable.
    this.handler.allowChangingPriorTone = true;
    if (opts.languageCode) {
      this.handler.languageCode = opts.languageCode;
    }
  }

  pushKey(key: Key): PushResult {
    let committed = "";
    let next: InputState = this.state;
    const handled = this.handler.handle(
      key,
      this.state,
      (newState) => {
        if (newState instanceof Committing) {
          // Committing is a transient marker — collapse to Empty so the next
          // keypress starts fresh, matching InputController's behavior.
          committed += newState.text;
          next = new Empty();
        } else if (newState instanceof EmptyIgnoringPrevious) {
          next = new Empty();
        } else {
          next = newState;
        }
      },
      () => {},
    );
    this.state = next;
    return { snapshot: this.snapshot(), committed, handled };
  }

  // Caller passes a 0-based absolute index into the full candidate list
  // (NOT a paged slot); host is responsible for tracking the mapping.
  selectCandidate(index: number): PushResult {
    if (!(this.state instanceof ChoosingCandidate)) {
      return { snapshot: this.snapshot(), committed: "", handled: false };
    }
    const candidate = this.state.candidates[index];
    if (!candidate) {
      return { snapshot: this.snapshot(), committed: "", handled: false };
    }
    let committed = "";
    let next: InputState = this.state;
    this.handler.candidateSelected(
      candidate,
      this.state.originalCursorIndex,
      (s) => {
        if (s instanceof Committing) {
          committed += s.text;
        } else {
          next = s;
        }
      },
    );
    this.state = next;
    return { snapshot: this.snapshot(), committed, handled: true };
  }

  // What `selectCandidate(index)` would leave in the composing buffer, without
  // selecting anything: it re-walks the grid, so segments outside the
  // candidate's own span can change too. Undefined when the index isn't a
  // selectable candidate.
  previewCandidate(index: number): CandidatePreview | undefined {
    if (!(this.state instanceof ChoosingCandidate)) {
      return undefined;
    }
    const candidate = this.state.candidates[index];
    if (!candidate) {
      return undefined;
    }
    const preview = this.handler.previewCandidateSelection(
      candidate,
      this.state.originalCursorIndex,
    );
    if (preview === undefined) {
      return undefined;
    }
    return {
      text: preview.composingBuffer,
      cursor: preview.cursorIndex,
      emphasis: { start: preview.emphasisStart, end: preview.emphasisEnd },
    };
  }

  // Swap the BPMF keyboard layout. Drops any in-flight composing buffer:
  // partial-syllable keys are layout-specific, so reusing them under a new
  // layout would scramble the syllable.
  setKeyboardLayout(name: KeyboardLayoutName): void {
    const next = keyboardLayoutFor(name);
    if (this.handler.keyboardLayout === next) return;
    this.handler.keyboardLayout = next;
    this.reset();
  }

  // LocalizedStrings only branches on the exact string "zh-TW"; anything
  // else falls back to English. No reset needed — affects status text only.
  setLanguageCode(code: string): void {
    this.handler.languageCode = code;
  }

  addUserPhrase(reading: string, value: string): void {
    this.model.addUserPhrase(reading, value);
  }

  addExcludedPhrase(reading: string, value: string): void {
    this.model.addExcludedPhrase(reading, value);
  }

  // Mirror of KeyHandler.buildMarkingState's validation (KeyHandler.ts:1620-1633):
  // syllable-count bounds + dedup. Thresholds 2/8 are private constants in
  // KeyHandler, hardcoded here too. `kind` picks which map dedup queries.
  checkPhraseStatus(
    kind: "add" | "exclude",
    reading: string,
    value: string,
  ): "ok" | "exists" | "tooShort" | "tooLong" {
    const syllables = reading.split("-").length;
    if (syllables < 2) return "tooShort";
    if (syllables > 8) return "tooLong";
    const map = kind === "add"
      ? this.model.getUserPhrases()
      : this.model.getExcludedPhrases();
    if (map.get(reading)?.includes(value)) return "exists";
    return "ok";
  }

  cancelChoosing(): Snapshot {
    const wasPunctuation = this.state instanceof ChoosingPunctuationList;
    if (this.state instanceof ChoosingCandidate) {
      this.handler.candidatePanelCancelled(
        this.state.originalCursorIndex,
        (s) => {
          this.state = s;
        },
      );
    }
    if (wasPunctuation) {
      // ChoosingPunctuationList inserted `_punctuation_list` into the grid;
      // candidatePanelCancelled only restored the cursor. Pop the
      // placeholder reading so the composing buffer returns to its
      // pre-backtick state.
      this.pushKey(Key.namedKey(KeyName.BACKSPACE));
    }
    return this.snapshot();
  }

  reset(): void {
    this.handler.reset();
    this.state = new Empty();
  }

  snapshot(): Snapshot {
    const s = this.state;
    if (s instanceof ChoosingCandidate) {
      // Menu-style entries (spanIndex < 0) have no segment in the grid; fall
      // back to the start of the buffer when every candidate is one.
      let leftmost = Infinity;
      for (const c of s.candidates) {
        if (c.spanIndex >= 0 && c.spanIndex < leftmost) leftmost = c.spanIndex;
      }
      return {
        kind: "choosing",
        mode: s instanceof ChoosingPunctuationList ? "punctuation" : "candidates",
        composing: s.composingBuffer,
        cursor: s.cursorIndex,
        anchorOffset: Number.isFinite(leftmost)
          ? this.handler.composedOffsetAt(leftmost)
          : 0,
        candidates: s.candidates.map((c) => ({
          reading: c.reading,
          value: c.value,
          displayedText: c.displayedText,
          spanIndex: c.spanIndex,
        })),
      };
    }
    if (s instanceof Marking) {
      const syllables = s.reading.split("-").length;
      let status: "ok" | "exists" | "tooShort" | "tooLong";
      if (s.acceptable) {
        status = "ok";
      } else if (syllables < 2) {
        status = "tooShort";
      } else if (syllables > 8) {
        status = "tooLong";
      } else {
        status = "exists";
      }
      return {
        kind: "marking",
        composing: s.composingBuffer,
        cursor: s.cursorIndex,
        markStart: s.head.length,
        markEnd: s.head.length + s.markedText.length,
        status,
      };
    }
    if (s instanceof Inputting) {
      return {
        kind: "inputting",
        composing: s.composingBuffer,
        cursor: s.cursorIndex,
        tooltip: s.tooltip,
        readingLength: this.handler.composedReading.length,
      };
    }
    return { kind: "empty" };
  }

  // Text format: each line `<phrase> <reading>`. `#`-prefixed lines and
  // blank lines are ignored by WebLanguageModel's parser.
  setUserPhrases(text: string): void {
    this.model.setUserPhrases(text);
  }

  setExcludedPhrases(text: string): void {
    this.model.setExcludedPhrases(text);
  }

  onUserPhraseChange(cb: (text: string) => void): void {
    this.model.setOnPhraseChange((m) => cb(serializePhraseMap(m)));
  }

  onExcludedPhraseChange(cb: (text: string) => void): void {
    this.model.setOnExcludedPhraseChange((m) => cb(serializePhraseMap(m)));
  }
}

function serializePhraseMap(phrases: Map<string, string[]>): string {
  let output = "";
  for (const [reading, list] of phrases) {
    for (const phrase of list) {
      output += `${phrase} ${reading}\n`;
    }
  }
  return output;
}

export { Key, KeyMapping, KeyName };
