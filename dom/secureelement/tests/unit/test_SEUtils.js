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

add_test(function test_byteArrayToHexString() {
  ok(!!SEUtils.byteArrayToHexString, "byteArrayToHexString not defined");
});

add_test(function test_hexStringToByteArray() {
  ok(!!SEUtils.hexStringToByteArray, "hexStringToByteArray not defined");
});

add_test(function test_arraysEqual() {
  ok(!!SEUtils.arraysEqual, "arraysEqual not defined");
});

add_test(function test_ensureIsArray() {
  ok(!!SEUtils.ensureIsArray, "ensureIsArray not defined");
});

add_test(function test_tlv() {
  ok(!!SEUtils.simpleTLV, "simpleTLV not defined");
});
