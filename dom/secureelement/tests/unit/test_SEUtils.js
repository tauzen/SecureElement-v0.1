/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* globals run_next_test, add_test, ok */
/* exported run_test */

function run_test() {
  ok(true, "Test init");
  run_next_test();
}

add_test(function test_firstTest() {
  ok(true, "First test");
});
