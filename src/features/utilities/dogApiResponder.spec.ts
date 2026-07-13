import assert from "node:assert/strict";
import { containsDogTrigger, isValidDogApiImageResponse } from "./dogApiResponder.js";

function run(): void {
  for (const text of ["犬", "いぬ", "INU", "inu", "dog", "DOG", "今日は犬です"]) {
    assert.equal(containsDogTrigger(text), true, text);
  }

  for (const text of ["猫", "cat", "寝る", ""]) {
    assert.equal(containsDogTrigger(text), false, text);
  }

  assert.equal(
    isValidDogApiImageResponse({
      message: "https://images.dog.ceo/breeds/shiba/shiba-1.jpg",
      status: "success",
    }),
    true,
  );
  assert.equal(isValidDogApiImageResponse({ message: "https://images.dog.ceo/breeds/shiba/shiba-1.jpg" }), false);
  assert.equal(isValidDogApiImageResponse({ message: "not-url", status: "success" }), false);
  assert.equal(isValidDogApiImageResponse({ message: "https://example.com/dog.jpg", status: "error" }), false);
}

try {
  run();
  console.log("dogApiResponder.spec.ts: all assertions passed");
} catch (err) {
  console.error(err);
  process.exit(1);
}
