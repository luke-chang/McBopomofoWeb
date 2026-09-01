/**
 * Verifies that the MacishMcBopomofo facade can drive the McBopomofo logic without
 * InputController, with the host owning candidate window navigation.
 */

import {
  Key,
  KeyboardLayoutName,
  KeyName,
  MacishMcBopomofo,
} from "./macishtype_facade";

describe("MacishMcBopomofo smoke test", () => {
  test("starts in empty state", () => {
    const engine = new MacishMcBopomofo();
    expect(engine.snapshot()).toEqual({ kind: "empty" });
  });

  test("transitions to inputting after typing one syllable", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    // Standard layout: 's' = ㄋ
    const r = engine.pushKey(Key.asciiKey("s"));
    expect(r.handled).toBe(true);
    expect(r.committed).toBe("");
    expect(r.snapshot.kind).toBe("inputting");
    if (r.snapshot.kind === "inputting") {
      expect(r.snapshot.composing).toMatch(/ㄋ/);
    }
  });

  test("forms a complete syllable and produces a walked best path", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    // Standard layout: s u 3 → ㄋㄧˇ → 你 etc.
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    const final = engine.pushKey(Key.asciiKey("3"));
    expect(final.snapshot.kind).toBe("inputting");
    if (final.snapshot.kind === "inputting") {
      // Walked path is a Han character, not raw bopomofo.
      expect(final.snapshot.composing).not.toMatch(/ㄋ/);
      expect(final.snapshot.composing.length).toBeGreaterThan(0);
    }
  });

  test("opens candidate list with Space key, exposing FULL list (no pagination)", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    const r = engine.pushKey(Key.namedKey(KeyName.SPACE));
    // Re-import with proper enum:
    expect(r.snapshot.kind).toBe("choosing");
    if (r.snapshot.kind === "choosing") {
      // ㄋㄧˇ has many homophones; full list should be substantial.
      expect(r.snapshot.candidates.length).toBeGreaterThan(9);
      expect(r.snapshot.candidates[0]).toHaveProperty("value");
      expect(r.snapshot.candidates[0]).toHaveProperty("reading");
    }
  });

  test("selectCandidate by absolute index pins the choice and returns to inputting", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    const choosing = engine.pushKey(Key.namedKey(KeyName.SPACE));
    if (choosing.snapshot.kind !== "choosing") throw new Error("not choosing");

    const targetIndex = 2; // pick the third candidate to verify it's not just default walk
    const targetValue = choosing.snapshot.candidates[targetIndex].value;
    const after = engine.selectCandidate(targetIndex);

    expect(after.handled).toBe(true);
    expect(after.snapshot.kind).toBe("inputting");
    if (after.snapshot.kind === "inputting") {
      expect(after.snapshot.composing).toBe(targetValue);
    }
  });

  test("cancelChoosing returns to inputting without committing", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    engine.pushKey(Key.namedKey(KeyName.SPACE));
    expect(engine.snapshot().kind).toBe("choosing");

    const snap = engine.cancelChoosing();
    expect(snap.kind).toBe("inputting");
  });

  test("Enter key commits the walked composing buffer", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    const beforeCommit = engine.snapshot();
    if (beforeCommit.kind !== "inputting") throw new Error("expected inputting");
    const walked = beforeCommit.composing;

    const r = engine.pushKey(Key.namedKey(KeyName.RETURN));
    expect(r.committed).toBe(walked);
    expect(r.snapshot.kind).toBe("empty");
  });

  test("UserOverrideModel learning: selecting same candidate twice biases the walk", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    const typeAndChoose = (idx: number): string => {
      engine.pushKey(Key.asciiKey("s"));
      engine.pushKey(Key.asciiKey("u"));
      engine.pushKey(Key.asciiKey("3"));
      const c = engine.pushKey(Key.namedKey(KeyName.SPACE));
      if (c.snapshot.kind !== "choosing") throw new Error("not choosing");
      const value = c.snapshot.candidates[idx].value;
      engine.selectCandidate(idx);
      engine.pushKey(Key.namedKey(KeyName.RETURN));
      return value;
    };

    // First time: pick the 3rd-ranked candidate to override default
    const picked = typeAndChoose(2);

    // Second time: type the same syllable, see if the walk now favors `picked`
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    const snap = engine.snapshot();
    if (snap.kind !== "inputting") throw new Error("expected inputting");
    expect(snap.composing).toBe(picked);
  });

  test("Shift+Left from inputting enters Marking state with emphasized mark range", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    // s u 3 c l 3 → 你好
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    engine.pushKey(Key.asciiKey("c"));
    engine.pushKey(Key.asciiKey("l"));
    engine.pushKey(Key.asciiKey("3"));
    const r = engine.pushKey(Key.namedKey(KeyName.LEFT, true));
    expect(r.snapshot.kind).toBe("marking");
    if (r.snapshot.kind === "marking") {
      expect(r.snapshot.composing.length).toBe(2);
      expect(r.snapshot.markEnd - r.snapshot.markStart).toBe(1);
    }
  });

  test("setUserPhrases() accepts text format and surfaces phrases as candidates", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.setUserPhrases("妳 ㄋㄧˇ\n");
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    const c = engine.pushKey(Key.namedKey(KeyName.SPACE));
    if (c.snapshot.kind !== "choosing") throw new Error("not choosing");
    expect(c.snapshot.candidates.some((x) => x.value === "妳")).toBe(true);
  });

  test("setExcludedPhrases() accepts text format and filters out the phrase", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.setExcludedPhrases("你 ㄋㄧˇ\n");
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    const c = engine.pushKey(Key.namedKey(KeyName.SPACE));
    if (c.snapshot.kind !== "choosing") throw new Error("not choosing");
    expect(c.snapshot.candidates.some((x) => x.value === "你")).toBe(false);
  });

  test("addUserPhrase() incrementally inserts a phrase visible in the candidate list", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.addUserPhrase("ㄋㄧˇ-ㄏㄠˇ", "妳好");
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    engine.pushKey(Key.asciiKey("c"));
    engine.pushKey(Key.asciiKey("l"));
    engine.pushKey(Key.asciiKey("3"));
    const c = engine.pushKey(Key.namedKey(KeyName.SPACE));
    if (c.snapshot.kind !== "choosing") throw new Error("not choosing");
    expect(c.snapshot.candidates.some((x) => x.value === "妳好")).toBe(true);
  });

  test("addExcludedPhrase() incrementally filters out the phrase", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.addExcludedPhrase("ㄋㄧˇ", "你");
    engine.pushKey(Key.asciiKey("s"));
    engine.pushKey(Key.asciiKey("u"));
    engine.pushKey(Key.asciiKey("3"));
    const c = engine.pushKey(Key.namedKey(KeyName.SPACE));
    if (c.snapshot.kind !== "choosing") throw new Error("not choosing");
    expect(c.snapshot.candidates.some((x) => x.value === "你")).toBe(false);
  });

  test("every manifest keyboard layout maps to a distinct Bopomofo layout", () => {
    // Names must match output/macishtype/manifest.json's picker values.
    const names: KeyboardLayoutName[] = [
      "Standard",
      "ETen",
      "Hsu",
      "ETen26",
      "HanyuPinyin",
      "IBM",
      "Su",
      "GinYieh",
      "MITAC",
    ];
    const composed = new Set<string>();
    for (const name of names) {
      const engine = new MacishMcBopomofo({ keyboardLayout: name });
      // 'g' lands on a different Bopomofo symbol in each layout.
      const result = engine.pushKey(Key.asciiKey("g"));
      expect(result.snapshot.kind).toBe("inputting");
      if (result.snapshot.kind !== "inputting") return;
      composed.add(result.snapshot.composing);
    }
    // HanyuPinyin composes latin letters, the rest bopomofo; all nine resolve
    // to a real layout rather than silently falling back to Standard.
    expect(composed.size).toBeGreaterThanOrEqual(6);
  });

  test("previewCandidate reports what selecting the candidate would produce", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    // Standard layout: hk4 g4 so4 → ㄘㄜˋ ㄕˋ ㄋㄟˋ, walked as the phrase 測試 plus 內.
    for (const char of "hk4g4so4") engine.pushKey(Key.asciiKey(char));
    const opened = engine.pushKey(Key.namedKey(KeyName.DOWN));
    expect(opened.snapshot.kind).toBe("choosing");
    if (opened.snapshot.kind !== "choosing") return;
    expect(opened.snapshot.composing).toBe("測試內");
    const index = opened.snapshot.candidates.findIndex(
      (candidate) => candidate.value === "室內"
    );
    expect(index).toBeGreaterThanOrEqual(0);

    // Pinning 室內 breaks up 測試, so 測 becomes 策 — the preview has to come
    // from a simulated walk, not from splicing 室內 into 測試內.
    expect(engine.previewCandidate(index)).toEqual({
      text: "策室內",
      cursor: 3,
      emphasis: { start: 1, end: 3 },
    });
  });

  test("previewCandidate agrees with selectCandidate", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    for (const char of "hk4g4so4") engine.pushKey(Key.asciiKey(char));
    const opened = engine.pushKey(Key.namedKey(KeyName.DOWN));
    if (opened.snapshot.kind !== "choosing") throw new Error("not choosing");

    // A handful is enough; each round trip rebuilds the language model.
    const sampled = Math.min(opened.snapshot.candidates.length, 8);
    for (let index = 0; index < sampled; index++) {
      const preview = engine.previewCandidate(index);
      expect(preview).toBeDefined();
      const clone = new MacishMcBopomofo({ keyboardLayout: "Standard" });
      for (const char of "hk4g4so4") clone.pushKey(Key.asciiKey(char));
      clone.pushKey(Key.namedKey(KeyName.DOWN));
      const selected = clone.selectCandidate(index);
      expect(selected.snapshot.kind).toBe("inputting");
      if (selected.snapshot.kind !== "inputting") return;
      expect(selected.snapshot.composing).toBe(preview?.text);
      expect(selected.snapshot.cursor).toBe(preview?.cursor);
      expect(
        preview?.text.slice(preview.emphasis.start, preview.emphasis.end)
      ).toBe(opened.snapshot.candidates[index].value);
    }
  });

  test("previewCandidate returns undefined when there is nothing to preview", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    expect(engine.previewCandidate(0)).toBeUndefined();
    for (const char of "hk4") engine.pushKey(Key.asciiKey(char));
    expect(engine.previewCandidate(0)).toBeUndefined();
    engine.pushKey(Key.namedKey(KeyName.DOWN));
    expect(engine.previewCandidate(-1)).toBeUndefined();
    expect(engine.previewCandidate(9999)).toBeUndefined();
  });

  test("anchorOffset reports characters, not readings", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    const push = (keys: string) => {
      for (const char of keys) {
        engine.pushKey(
          char === "_" ? Key.namedKey(KeyName.SPACE) : Key.asciiKey(char)
        );
      }
    };
    // 巴貝多, then pick 🇧🇧 for all three readings and add a fourth (ㄋㄧˇ).
    push("18_1o42ji_");
    const opened = engine.pushKey(Key.namedKey(KeyName.DOWN));
    if (opened.snapshot.kind !== "choosing") throw new Error("not choosing");
    engine.selectCandidate(
      opened.snapshot.candidates.findIndex(
        (candidate) => candidate.value === "🇧🇧"
      )
    );
    push("su3");
    const reopened = engine.pushKey(Key.namedKey(KeyName.DOWN));
    if (reopened.snapshot.kind !== "choosing") throw new Error("not choosing");

    expect(reopened.snapshot.composing).toBe("🇧🇧你");
    // Every candidate sits at reading 3, which is character 4 of five.
    expect(
      reopened.snapshot.candidates.every(
        (candidate) => candidate.spanIndex === 3
      )
    ).toBe(true);
    expect(reopened.snapshot.anchorOffset).toBe(4);
  });

  test("checkPhraseStatus(add) classifies the four states", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    expect(engine.checkPhraseStatus("add", "ㄋㄧˇ-ㄏㄠˇ", "妳好")).toBe("ok");
    engine.addUserPhrase("ㄋㄧˇ-ㄏㄠˇ", "妳好");
    expect(engine.checkPhraseStatus("add", "ㄋㄧˇ-ㄏㄠˇ", "妳好")).toBe("exists");
    expect(engine.checkPhraseStatus("add", "ㄋㄧˇ", "你")).toBe("tooShort");
    const nineSyllables = Array(9).fill("ㄋㄧˇ").join("-");
    expect(engine.checkPhraseStatus("add", nineSyllables, "你你你你你你你你你")).toBe("tooLong");
  });

  test("checkPhraseStatus(exclude) reads the excluded map for the exists check", () => {
    const engine = new MacishMcBopomofo({ keyboardLayout: "Standard" });
    engine.addExcludedPhrase("ㄋㄧˇ-ㄏㄠˇ", "你好");
    expect(engine.checkPhraseStatus("exclude", "ㄋㄧˇ-ㄏㄠˇ", "你好")).toBe("exists");
    // user-phrase add doesn't count as excluded
    engine.addUserPhrase("ㄋㄧˇ-ㄏㄠˇ", "妳好");
    expect(engine.checkPhraseStatus("exclude", "ㄋㄧˇ-ㄏㄠˇ", "妳好")).toBe("ok");
  });
});
