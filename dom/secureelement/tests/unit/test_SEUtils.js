/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* globals run_next_test, add_test, ok, Components, SEUtils */
/* exported run_test */

Components.import("resource://gre/modules/SEUtils.jsm");

function run_test() {
  ok(!!SEUtils, "SEUtils should be available");
  run_next_test();
}

const VALID_HEX_STR = "0123456789ABCDEF";
const VALID_HEX_STR_LC = "0123456789abcdef";
const VALID_BYTE_ARR = [0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF];

add_test(function test_byteArrayToHexString() {
  let hexStr = SEUtils.byteArrayToHexString(VALID_BYTE_ARR);
  ok(hexStr === VALID_HEX_STR, 
     "should convert byte Array to uppercased hex string");

  [[], null, undefined, "test", {}].forEach((input) => {
    hexStr = SEUtils.byteArrayToHexString(input);
    ok(hexStr === "", "invalid arg:" + input + " should return empty string");
  });
});

add_test(function test_hexStringToByteArray() {
  let byteArr = SEUtils.hexStringToByteArray(VALID_HEX_STR);
  ok(SEUtils.arraysEqual(byteArr, VALID_BYTE_ARR),
     "should convert uppercased string to byte Array");

  byteArr = SEUtils.hexStringToByteArray(VALID_HEX_STR_LC);
  ok(SEUtils.arraysEqual(byteArr, VALID_BYTE_ARR),
     "should convert lowercased string to byte Array");

  ["", null, undefined, {}, [], "123"].forEach((input) => {
    byteArr = SEUtils.hexStringToByteArray(input);
    ok(byteArr === [], "invalid arg:" + input + " should return empty Array");
  });
});

add_test(function test_arraysEqual() {
  ok(SEUtils.arraysEqual([1, 2, 3], [1, 2, 3]),
     "should return true on equal Arrays");

  [[1], [1, 2, 4], [3, 2, 1]].forEach((input) => {
    ok(!SEUtils.arraysEqual([1, 2, 3], input),
       "should return false when Arrays not equal");
  });

  [null, undefined, "abc"].forEach((input) => {
    ok(!SEUtils.arraysEqual([1, 2, 3], input),
       "should return false when comparing Array with invalid argument");

    ok(!SEUtils.arraysEqual(input, input),
       "should return false when both args are invalid");
  });
});

add_test(function test_tlv_parse() {
  ok(!!SEUtils.simpleTLV, "simpleTLV not defined");
});

add_test(function test_tlv_ensureIsArray() {
  let res = SEUtils.simpleTLV.ensureIsArray([1]);
  ok(SEUtils.arraysEqual(res, [1]),
     "should not modify array");

  [1, "abc", {a: "b"}].forEach((input) => {
    res = SEUtils.simpleTLV.ensureIsArray(input);
    ok(Array.isArray(res), "should return Array");
    ok(res.length === 1, "Array should have 1 element");
    ok(res[0] === input, "should wrap argument into Array");
  });
});
