import type { ConfirmEvent, InputEngine, KeyEvent } from "./macishtype_contract";
import { Key, KeyboardLayoutName, KeyMapping, KeyName, MacishMcBopomofo, PushResult } from "./macishtype_facade";

// LocalizedStrings only branches on the literal "zh-TW"; map any Traditional
// Chinese tag (zh-TW / zh-Hant / zh-Hant-TW / zh-Hant-HK) onto it. Everything
// else (including Simplified zh-CN / zh-Hans and ambiguous zh) falls through
// to English so users aren't shown the wrong-script text.
function pickLanguageCode(): string {
  for (const lang of navigator.languages) {
    const lower = lang.toLowerCase();
    if (lower === "zh-tw" || lower.startsWith("zh-hant")) return "zh-TW";
  }
  return "en";
}

// Shared by Marking tooltip and the candidate-window + / - flow. `kind`
// only affects ok / exists wording; length-limit text is shared.
function formatPhraseOpTooltip(
  kind: "add" | "exclude",
  value: string,
  status: "ok" | "exists" | "tooShort" | "tooLong",
): string {
  const verb = kind === "add" ? "加入" : "排除";
  switch (status) {
    case "ok":       return `${verb}「${value}」  ↵`;
    case "exists":   return `「${value}」已${kind === "add" ? "存在" : "排除"}`;
    case "tooShort": return "需 2 字以上";
    case "tooLong":  return "超過 8 字";
  }
}

// These layouts print their symbols at fixed US-QWERTY positions, so
// composition must follow the physical key (event.code), not the produced char
// — otherwise a non-QWERTY OS layout (Dvorak etc.) breaks them. The
// letter-mnemonic ones (倚天 / 許氏 / 倚天26 / 拼音 / 神通) are typed by letter and stay
// correct on event.key. Must stay in sync with BopomofoKeyboardLayout's
// position-based maps; the wrapper can't detect drift.
const POSITIONAL_LAYOUTS: ReadonlySet<KeyboardLayoutName> = new Set([
  "Standard",
  "IBM",
  "Su",
  "GinYieh",
]);

const PUNCTUATION_FOR_CODE: ReadonlyMap<string, string> = new Map([
  ["Comma", ","], ["Period", "."], ["Semicolon", ";"], ["Slash", "/"], ["Minus", "-"],
]);

// W3C event.code → US-QWERTY lowercase char for exactly the keys the Standard /
// IBM maps use (letters, digits, , . ; / -); undefined otherwise so the caller
// falls back to event.key. Lowercase is required — isValidKey looks it up
// verbatim. Must cover every key in those layouts (see POSITIONAL_LAYOUTS).
function qwertyCharForCode(code: string): string | undefined {
  if (code.length === 4 && code.startsWith("Key")) {
    const letter = code.charCodeAt(3);
    // "KeyA".."KeyZ" → 'a'..'z' (length 4 excludes "Numpad*").
    if (letter >= 65 && letter <= 90) return String.fromCharCode(letter + 32);
  }
  if (code.length === 6 && code.startsWith("Digit")) {
    const digit = code.charCodeAt(5);
    if (digit >= 48 && digit <= 57) return code[5];
  }
  return PUNCTUATION_FOR_CODE.get(code);
}

// Every index the host takes — cursor, staged, emphasis, anchorAt — counts
// extended grapheme clusters, while JS string offsets count UTF-16 code units.
// The language model reaches well past the BMP, as far as flag emoji (巴貝多 →
// 🇧🇧: four UTF-16 units, one grapheme), so offsets need converting on the way
// out.
//
// Intl.Segmenter is guaranteed by both hosts but isn't in this project's TS lib
// (target es6), hence the local declaration.
interface GraphemeSegmenter {
  segment(input: string): Iterable<{ index: number }>;
}

const IntlWithSegmenter = Intl as unknown as {
  Segmenter: new (
    locales?: string,
    options?: { granularity: "grapheme" },
  ) => GraphemeSegmenter;
};

// Ordinary Han input never reaches it, so build on first use.
let graphemeSegmenter: GraphemeSegmenter | undefined;

// A surrogate half, joiner, combining mark or variation selector. Without one,
// a UTF-16 unit is a grapheme and the offset already agrees — the common case.
const MULTI_UNIT_GRAPHEME =
  /[\uD800-\uDFFF\u0300-\u036F\u200D\u20D0-\u20FF\uFE00-\uFE0F]/;

// UTF-16 offset into `text` → grapheme clusters before it. `offset` is assumed
// to sit on a cluster boundary, as the engine's node boundaries do.
function graphemeIndex(text: string, offset: number): number {
  if (offset <= 0 || !MULTI_UNIT_GRAPHEME.test(text)) return offset;
  graphemeSegmenter ??= new IntlWithSegmenter.Segmenter(undefined, {
    granularity: "grapheme",
  });
  let count = 0;
  for (const { index } of graphemeSegmenter.segment(text)) {
    if (index >= offset) break;
    count++;
  }
  return count;
}

interface ComposeKeyInput {
  code: string;
  key: string;
  shift: boolean;
  ctrl: boolean;
  isNumpad: boolean;
}

// The char to compose with: for positional layouts the physical-position QWERTY
// char (so Dvorak composes by position), else the produced char. Shift / Ctrl /
// Numpad always fall back. Pure (layout passed in, not read) so it unit-tests
// directly.
function composedAscii(args: ComposeKeyInput, layout: KeyboardLayoutName): string {
  if (!args.shift && !args.ctrl && !args.isNumpad && POSITIONAL_LAYOUTS.has(layout)) {
    const c = qwertyCharForCode(args.code);
    if (c !== undefined) return c;
  }
  return args.key;
}

export default class McBopomofoEngine implements InputEngine {
  // Shared across all InputEngineContext instances so the facade's
  // UserOverrideModel accumulates observations across text fields.
  static engine = new MacishMcBopomofo({
    keyboardLayout: manifest.settings.keyboardLayout as KeyboardLayoutName,
    languageCode: pickLanguageCode(),
  });

  private pendingKey: Key | null = null;

  // + / - on a candidate enters a modal confirmation; null when idle.
  private pendingPhraseOp: {
    kind: "add" | "exclude";
    reading: string;
    value: string;
    status: "ok" | "exists" | "tooShort" | "tooLong";
  } | null = null;

  // Host doesn't expose candidate-window highlight; track it via the idx
  // payload that `_apply` attaches and `candidateSelectionChanged` echoes.
  private lastChoosingHighlight = 0;

  // Host ended composition — in-app commit (click elsewhere, Cmd+A) or
  // session deactivate (app switch, focus loss). The controller already
  // committed stagedText; drop the facade grid so it doesn't ghost back on the
  // next key. Fires with nothing composing too, so it stays idempotent.
  compositionEnded(): void {
    McBopomofoEngine.engine.reset();
    this.pendingKey = null;
    this.pendingPhraseOp = null;
    this.lastChoosingHighlight = 0;
  }

  handleKey(event: KeyEvent): boolean {
    this.pendingKey = null;

    const snap = McBopomofoEngine.engine.snapshot();

    // +/- confirmation modal. Enter routes confirm through
    // commitSelectedCandidate (shared with the mouse double-click via
    // candidateConfirmed); Esc cancels here; everything else is swallowed.
    if (this.pendingPhraseOp) {
      if (event.code === "Enter") {
        event.commitSelectedCandidate();
        return true;
      }
      if (event.code === "Escape") {
        this._resolvePendingPhraseOp(event, false);
        return true;
      }
      return true;
    }

    // Command / option / ctrl combos don't route through cleanly: command
    // and option aren't modeled by KeyHandler (Cmd+V on some IMK clients
    // arrives as bare "v" and would come back as bopomofo); ctrl triggers
    // flows the wrapper has no UI for (Ctrl+\\ → SelectingFeature state).
    // Swallow while composing to protect the buffer; passthrough when idle.
    if (event.metaKey || event.altKey || event.ctrlKey) {
      return snap.kind !== "empty";
    }

    if (snap.kind === "choosing") {
      // Host owns nav keys, Enter, and index-label keys while the candidate
      // window is visible (handleNavigationKeys / handleIndexLabelKeys default
      // to true): they route through the host's navigate / commit path and
      // surface as our candidateSelectionChanged / candidateConfirmed callbacks.
      const punctMode = snap.mode === "punctuation";
      // Digit not in indexLabels (so the host didn't intercept it): swallow in
      // the symbol menu, pass through otherwise. Must precede the deferred-key
      // path below, which would otherwise commit a candidate on a stray digit.
      if (event.key.length === 1 && /^[0-9]$/.test(event.key)) {
        return punctMode;
      }
      // Space pages forward through the candidate list (no wrapping). The host
      // owns Enter for commit; Space is not a host nav key, so it reaches us.
      if (event.code === "Space") {
        event.navigateCandidates("pageForward");
        return true;
      }
      // cancelChoosing routes through candidatePanelCancelled (NOT
      // pushKey). Backspace cancels in symbol-menu mode, but edits the
      // reading buffer in regular candidate mode.
      if (event.code === "Escape" || (punctMode && event.code === "Backspace")) {
        const snapshot = McBopomofoEngine.engine.cancelChoosing();
        this._apply(event, { snapshot, committed: "", handled: true });
        return true;
      }
      // Forward to facade, NOT deferred-key: deferred would commit an
      // unselected candidate before the delete reaches the reading buffer.
      if (event.code === "Backspace" || event.code === "Delete") {
        const key = this._translate(event);
        if (key) {
          const result = McBopomofoEngine.engine.pushKey(key);
          this._apply(event, result);
          return result.handled;
        }
        return true;
      }
      // + / - on the highlighted candidate: enter the modal confirmation
      // tooltip (handled at the top of handleKey on the next keypress).
      // Must precede the deferred-key path; otherwise + / - would commit
      // the candidate and type the character. Keyed by physical code so
      // the binding lands on the same physical key across layouts, and on
      // the dedicated numpad + / - keys.
      if (!punctMode) {
        const opKind: "add" | "exclude" | null =
          event.code === "Equal" || event.code === "NumpadAdd" ? "add" :
          event.code === "Minus" || event.code === "NumpadSubtract" ? "exclude" :
          null;
        if (opKind) {
          const c = snap.candidates[this.lastChoosingHighlight];
          if (c && c.spanIndex >= 0) {
            const status = McBopomofoEngine.engine.checkPhraseStatus(
              opKind, c.reading, c.value,
            );
            this.pendingPhraseOp = {
              kind: opKind, reading: c.reading, value: c.value, status,
            };
            // Keep the window under the same anchor _apply's choosing case
            // used, so the tooltip doesn't jump.
            // Opt out of host nav interception so Enter (confirm) / Escape
            // (cancel) reach the pendingPhraseOp handler at the top of handleKey.
            event.updateCandidates(
              [{ candidate: formatPhraseOpTooltip(opKind, c.value, status) }],
              {
                anchorAt: graphemeIndex(snap.composing, snap.anchorOffset),
                initialHighlight: -1,
                indexLabels: "",
                handleNavigationKeys: false,
              },
            );
          }
          return true;
        }
      }
      // Deferred-key: commit highlighted candidate, then push char on the
      // confirmed callback to start a new syllable. Swallowed in symbol menu.
      if (event.key.length === 1) {
        if (punctMode) return true;
        // Same positional remap as _translate, for the char that starts the
        // next syllable. ctrl/numpad can't occur here (ctrl returned earlier;
        // bare single char).
        const ascii = this.composeChar({
          code: event.code,
          key: event.key,
          shift: event.shiftKey,
          ctrl: false,
          isNumpad: false,
        });
        this.pendingKey = Key.asciiKey(ascii, event.shiftKey);
        event.commitSelectedCandidate();
        return true;
      }
      // Reached only by keys the host didn't own (e.g. Shift+Arrow) while the
      // candidate window is up. Swallow them; returning false lets IMK tear
      // down the active composition.
      return true;
    }

    // Marking Enter (save) routes through commitSelectedCandidate, sharing
    // candidateConfirmed's marking branch with the mouse double-click. Other
    // marking keys fall through to the facade below.
    if (snap.kind === "marking" && event.code === "Enter") {
      event.commitSelectedCandidate();
      return true;
    }

    // Native-style two-step Esc: with a partial bopomofo, let KeyHandler
    // clear just `reading_`; otherwise commit the walked prefix and dismiss.
    if (event.code === "Escape" && snap.kind === "inputting") {
      if (snap.readingLength > 0) {
        const key = this._translate(event);
        if (key) {
          const result = McBopomofoEngine.engine.pushKey(key);
          this._apply(event, result);
          return result.handled;
        }
      }
      event.flushStaged();
      McBopomofoEngine.engine.reset();
      return true;
    }

    const key = this._translate(event);
    // Mid-composition, swallow the unrecognized key so IMK keeps the marked
    // text; pass through to the OS only when idle.
    if (!key) return snap.kind !== "empty";
    const result = McBopomofoEngine.engine.pushKey(key);
    this._apply(event, result);
    return result.handled;
  }

  // Single confirm executor, branching on facade state, not source: a mouse
  // double-click arrives directly; keyboard Enter routes here via the host's
  // commit path (handleKey re-emits tooltip Enters as commitSelectedCandidate).
  //
  // Always return true: returning undefined makes the host flushStaged, which
  // would prematurely commit a still-composing inputting state.
  candidateConfirmed(event: ConfirmEvent): boolean {
    // +/- modal: resolve the op. Checked first — the facade is still
    // "choosing" here, so the snapshot below can't distinguish it.
    if (this.pendingPhraseOp) {
      this._resolvePendingPhraseOp(event, true);
      return true;
    }

    const snap = McBopomofoEngine.engine.snapshot();
    // Marking row: save the phrase (push Return). If it stays stuck in Marking
    // (phrase already exists), force-exit with Esc.
    if (snap.kind === "marking") {
      const result = McBopomofoEngine.engine.pushKey(Key.namedKey(KeyName.RETURN));
      if (result.snapshot.kind === "marking") {
        this._apply(event, McBopomofoEngine.engine.pushKey(Key.namedKey(KeyName.ESC)));
      } else {
        this._apply(event, result);
      }
      return true;
    }

    // Real candidate: select the index. -1 (commitSelectedCandidate with no
    // highlight) or non-choosing state has nothing to select.
    if (snap.kind !== "choosing" || event.absoluteIndex < 0) return true;

    const result = McBopomofoEngine.engine.selectCandidate(event.absoluteIndex);
    this._apply(event, result);

    if (this.pendingKey) {
      const pendingResult = McBopomofoEngine.engine.pushKey(this.pendingKey);
      this._apply(event, pendingResult);
      this.pendingKey = null;
    }
    return true;
  }

  // Live preview of the highlighted candidate, including the initial highlight
  // the host reports right after updateCandidates. Restore is automatic when
  // the candidate window closes — _apply's inputting / empty cases emit
  // composing without emphasis, clearing the thick underline.
  // Also tracks the highlighted candidate idx so the + / - intercept in
  // handleKey knows which candidate the user is operating on.
  // Return true to suppress the host fallback (currently a no-op, but the
  // contract reserves it for future host defaults). We fully own the preview.
  candidateSelectionChanged(event: ConfirmEvent): boolean {
    // A mouse single-click fires this even on the +/- tooltip; recording its
    // index would drop the user back to candidate 0 on confirm. Ignore while
    // the modal is up.
    if (this.pendingPhraseOp) return true;
    if (event.absoluteIndex < 0) return true;
    this.lastChoosingHighlight = event.absoluteIndex;
    // Whole-buffer preview from the facade — anything less can contradict what
    // the commit produces.
    const preview = McBopomofoEngine.engine.previewCandidate(event.absoluteIndex);
    if (!preview) return true;
    this._markedText(event, preview.text, {
      cursor: preview.cursor,
      staged: -1,
      emphasis: preview.emphasis,
    });
    return true;
  }

  // Sole exit for marked text, so the UTF-16 → grapheme conversion lives in one
  // place: the facade reports plain JS string offsets, the host counts characters.
  private _markedText(
    event: KeyEvent | ConfirmEvent,
    text: string,
    options: {
      cursor?: number;
      staged: number;
      emphasis?: { start: number; end: number };
    },
  ): void {
    event.updateMarkedText(text, {
      cursor:
        options.cursor === undefined
          ? undefined
          : graphemeIndex(text, options.cursor),
      // Negative stages the whole text; it's a count, not an offset.
      staged:
        options.staged < 0 ? options.staged : graphemeIndex(text, options.staged),
      emphasis: options.emphasis && {
        start: graphemeIndex(text, options.emphasis.start),
        end: graphemeIndex(text, options.emphasis.end),
      },
    });
  }

  // Confirm (run the op when status is "ok") or abandon the +/- modal, then
  // re-emit the choosing list under the saved highlight. The snapshot is taken
  // before mutating the LM so the restored list matches what's on screen.
  private _resolvePendingPhraseOp(
    event: KeyEvent | ConfirmEvent,
    confirm: boolean,
  ): void {
    const snap = McBopomofoEngine.engine.snapshot();
    const op = this.pendingPhraseOp;
    if (confirm && op && op.status === "ok") {
      if (op.kind === "add") {
        McBopomofoEngine.engine.addUserPhrase(op.reading, op.value);
      } else {
        McBopomofoEngine.engine.addExcludedPhrase(op.reading, op.value);
      }
    }
    this.pendingPhraseOp = null;
    this._apply(
      event,
      { snapshot: snap, committed: "", handled: true },
      this.lastChoosingHighlight,
    );
  }

  // Reuse McBopomofo's canonical web-event → Key mapper. Host KeyEvent
  // isn't a DOM Event subtype, but it duck-types the fields KeyMapping
  // reads (code / key / shiftKey / ctrlKey); cast is localized here so
  // the rest of the file stays well-typed.
  //
  // KeyMapping falls back to `Key(event.key, UNKNOWN, ...)` for codes it
  // doesn't recognize, which means F-keys / audio keys / modifier-only
  // presses come back with a multi-char `ascii`. Treat those as "no key
  // for the facade".
  private _translate(event: KeyEvent): Key | null {
    const key = KeyMapping.keyFromKeyboardEvent(event as unknown as KeyboardEvent);
    if (key.name === KeyName.UNKNOWN && event.key.length !== 1) return null;
    // composeChar returns key.ascii unchanged unless a positional layout remaps
    // it, so the Key is rebuilt only when needed.
    const ascii = this.composeChar({
      code: event.code,
      key: key.ascii,
      shift: key.shiftPressed,
      ctrl: key.ctrlPressed,
      isNumpad: key.isNumpadKey,
    });
    return ascii === key.ascii
      ? key
      : new Key(ascii, key.name, key.shiftPressed, key.ctrlPressed, key.isNumpadKey);
  }

  // The one place the wrapper reads the live layout; the decision is in the pure
  // composedAscii.
  private composeChar(args: ComposeKeyInput): string {
    return composedAscii(args, manifest.settings.keyboardLayout as KeyboardLayoutName);
  }

  // `initialHighlight` only matters for the choosing case; defaults to 0
  // (host's natural "highlight first" behavior). Pending +/- exit passes
  // the saved highlight to preserve the user's selection across the
  // tooltip detour.
  private _apply(
    event: KeyEvent | ConfirmEvent,
    result: PushResult,
    initialHighlight: number = 0,
  ): void {
    if (result.committed) {
      // Sync stagedText to exactly what the facade wants committed, then
      // flush. flushStaged appends to stagedText, so passing committed
      // verbatim alongside an already-staged copy would double-insert.
      this._markedText(event, result.committed, { staged: -1 });
      event.flushStaged();
    }
    // No-op key (e.g. arrow / Backspace in Empty): emitting any action makes
    // the bridge mark the keypress handled, eating IMK passthrough.
    if (!result.handled && !result.committed) {
      return;
    }
    const snap = result.snapshot;
    if (snap.kind !== "choosing" && snap.kind !== "marking") {
      event.updateCandidates([]);
    }
    switch (snap.kind) {
      case "empty":
        if (!result.committed) event.resetContext();
        break;
      case "inputting": {
        // Keep the trailing in-progress bopomofo out of staged so a
        // deactivate flush won't commit intermediate state. Mid-buffer
        // cursor falls back to -1 — staging only a prefix would also
        // drop the walked tail, which is worse than carrying the reading.
        const atEnd = snap.cursor === snap.composing.length;
        const staged = atEnd && snap.readingLength > 0
          ? snap.composing.length - snap.readingLength
          : -1;
        this._markedText(event, snap.composing, {
          cursor: snap.cursor,
          staged,
        });
        break;
      }
      case "marking": {
        this._markedText(event, snap.composing, {
          cursor: snap.cursor,
          staged: -1,
          emphasis: { start: snap.markStart, end: snap.markEnd },
        });
        const marked = snap.composing.slice(snap.markStart, snap.markEnd);
        // Status-line role: empty `indexLabels` hides the leading "1." and
        // `initialHighlight: -1` keeps the row from looking selectable. Opt out
        // of host nav interception so arrows (extend / shrink the mark) and
        // Enter (save) reach handleKey instead of navigating / committing this
        // 1-item window.
        event.updateCandidates(
          [{ candidate: formatPhraseOpTooltip("add", marked, snap.status) }],
          {
            anchorAt: graphemeIndex(snap.composing, snap.markStart),
            initialHighlight: -1,
            indexLabels: "",
            handleNavigationKeys: false,
          },
        );
        break;
      }
      case "choosing": {
        // The walked buffer as it stands; the preview lands on top of it via
        // candidateSelectionChanged, which the host fires for initialHighlight too.
        this._markedText(event, snap.composing, { cursor: snap.cursor, staged: -1 });
        event.updateCandidates(
          snap.candidates.map((c) => ({ candidate: c.value })),
          {
            anchorAt: graphemeIndex(snap.composing, snap.anchorOffset),
            initialHighlight,
          },
        );
        break;
      }
    }
  }
}

// Host sanitize pins values to the picker option set:
//   keyboardLayout → KeyboardLayoutName (1:1 by construction)
//   candidateKeys  → string the host accepts as indexLabels
function applyConfig() {
  McBopomofoEngine.engine.setKeyboardLayout(
    manifest.settings.keyboardLayout as KeyboardLayoutName,
  );
  manifest.candidateWindow.indexLabels = manifest.settings.candidateKeys as string;
}
applyConfig();
addEventListener("settingschange", applyConfig);

// User / excluded phrases persistence. Text format matches the web example
// (each line `<phrase> <reading>`), readable / hand-editable from the
// per-engine _storage/ folder. Restore first, then attach save callbacks
// so the bulk-set above can't echo back into storage.
McBopomofoEngine.engine.setUserPhrases(localStorage.getItem("user_phrases") ?? "");
McBopomofoEngine.engine.setExcludedPhrases(localStorage.getItem("excluded_phrases") ?? "");
McBopomofoEngine.engine.onUserPhraseChange((text) => {
  localStorage.setItem("user_phrases", text);
});
McBopomofoEngine.engine.onExcludedPhraseChange((text) => {
  localStorage.setItem("excluded_phrases", text);
});

// React to system language preference changes (System Settings → Language).
addEventListener("languagechange", () => {
  McBopomofoEngine.engine.setLanguageCode(pickLanguageCode());
});

// Re-load when the user hand-edits the storage files in Finder / shell.
// Spec-compliant: the engine's own setItem above doesn't self-fire, so no cycle.
// `event.newValue` is a lazy disk read — only touch it when the key matches.
addEventListener("storage", (event) => {
  if (event.key === "user_phrases") {
    McBopomofoEngine.engine.setUserPhrases(event.newValue ?? "");
  } else if (event.key === "excluded_phrases") {
    McBopomofoEngine.engine.setExcludedPhrases(event.newValue ?? "");
  }
});
