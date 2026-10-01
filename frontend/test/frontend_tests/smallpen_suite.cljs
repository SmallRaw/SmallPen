;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen-suite
  "Registry of the SmallPen test namespaces. Register new SmallPen tests
  here, not in `frontend-tests.runner`, so the runner stays identical to
  upstream except for one hook."
  (:require
   [frontend-tests.data.smallpen-interactions-test]
   [frontend-tests.smallpen-shell-test]
   [frontend-tests.smallpen.ds-real-refs-test]
   [frontend-tests.smallpen.dse-test]
   [frontend-tests.smallpen.home-test]
   [frontend-tests.smallpen.panorama-probe-test]
   [frontend-tests.smallpen.projection-test]
   [frontend-tests.smallpen.session-test]
   [frontend-tests.smallpen.thumbnails-test]
   [frontend-tests.smallpen.upstream-inert-test]
   [frontend-tests.tokens.library-assets-data-test]
   [frontend-tests.tokens.matrix-data-test]
   [frontend-tests.tokens.quick-panel-data-test]
   [frontend-tests.tokens.quick-panel-test]
   [frontend-tests.tokens.smallpen-matrix-test]
   [frontend-tests.ui.colorpicker-reference-input-test]
   [frontend-tests.ui.smallpen-history-test]
   [frontend-tests.ui.smallpen-ui-helpers-test]
   [frontend-tests.ui.workspace-history-test]))

(def test-namespaces
  ['frontend-tests.data.smallpen-interactions-test
   'frontend-tests.smallpen-shell-test
   'frontend-tests.smallpen.ds-real-refs-test
   'frontend-tests.smallpen.dse-test
   'frontend-tests.smallpen.home-test
   'frontend-tests.smallpen.panorama-probe-test
   'frontend-tests.smallpen.projection-test
   'frontend-tests.smallpen.session-test
   'frontend-tests.smallpen.thumbnails-test
   'frontend-tests.smallpen.upstream-inert-test
   'frontend-tests.tokens.library-assets-data-test
   'frontend-tests.tokens.matrix-data-test
   'frontend-tests.tokens.quick-panel-data-test
   'frontend-tests.tokens.quick-panel-test
   'frontend-tests.tokens.smallpen-matrix-test
   'frontend-tests.ui.colorpicker-reference-input-test
   'frontend-tests.ui.smallpen-history-test
   'frontend-tests.ui.smallpen-ui-helpers-test
   'frontend-tests.ui.workspace-history-test])
