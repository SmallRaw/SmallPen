;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.refs
  "Refs for SmallPen UI guards in upstream components. They derive plain
  booleans so the components only re-render when the guard flips."
  (:require
   [app.main.smallpen.edit-policy :as dsep]
   [app.main.store :as st]
   [okulary.core :as l]))

(def design-system-page?
  "True while the generated SmallPen Design System page is open."
  (l/derived dsep/current-page-locked? st/state))
