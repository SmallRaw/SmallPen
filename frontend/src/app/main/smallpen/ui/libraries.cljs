;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.libraries
  "SmallPen content of the workspace libraries dialog. A SmallPen package
  stands alone: components and Tokens from another package are reused by
  copying its files into this one, so the dialog only says so."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn dialog-tabs
  "The libraries dialog shows a single tab in SmallPen."
  []
  [{:label (tr "workspace.libraries.libraries")
    :id "smallpen"}])

(mf/defc libraries-tab*
  []
  [:div {:class (stl/css :libraries-content)}
   [:section {:class (stl/css :library-section)}
    [:> title-bar* {:collapsable false
                    :title (tr "workspace.libraries.in-this-file")
                    :class (stl/css :title-spacing)}]
    [:p {:class (stl/css :source-help)
         :data-testid "smallpen-libraries-standalone"}
     (tr "workspace.libraries.smallpen.standalone")]]])
