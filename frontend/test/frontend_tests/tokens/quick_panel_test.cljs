;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.tokens.quick-panel-test
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom/server" :as react-dom]
   [app.common.types.tokens-lib :as ctob]
   [app.main.ui.context :as ctx]
   [app.main.ui.workspace.tokens.quick-panel :refer [quick-token-panel*]]
   [app.util.globals :as globals]
   [cljs.test :as t]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

(def ^:private brand
  {:id #uuid "00000000-0000-4000-8000-000000000001"
   :name "color.brand"
   :type :color
   :value "#6750a4"})

(defn- render-panel
  [{:keys [can-edit read-only]}]
  (let [original-document globals/document
        document (.. (JSDOM. "<!doctype html><body></body>") -window -document)
        element (mf/html
                 [:> (mf/provider ctx/can-edit?) {:value can-edit}
                  [:> (mf/provider ctx/workspace-read-only?) {:value read-only}
                   [:> quick-token-panel*
                    {:tokens-lib (ctob/make-tokens-lib)
                     :active-tokens {"color.brand" brand}
                     :resolved-active-tokens {"color.brand" (assoc brand :resolved-value "#6750a4")}}]]])]
    (set! globals/document document)
    (try
      (react-dom/renderToStaticMarkup element)
      (finally
        (set! globals/document original-document)))))

;; The token pill ignores clicks unless it receives `can-edit`; without it
;; the quick panel rendered every pill as a read-only viewer pill and token
;; application silently did nothing.
(t/deftest editable-workspace-renders-clickable-pills
  (let [markup (render-panel {:can-edit true :read-only false})]
    (t/is (str/includes? markup "token-pill-default"))
    (t/is (not (str/includes? markup "token-pill-viewer")))))

(t/deftest read-only-workspace-renders-viewer-pills
  (let [markup (render-panel {:can-edit true :read-only true})]
    (t/is (str/includes? markup "token-pill-viewer"))))
