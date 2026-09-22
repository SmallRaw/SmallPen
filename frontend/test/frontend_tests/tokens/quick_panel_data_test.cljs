;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.tokens.quick-panel-data-test
  (:require
   [app.main.ui.workspace.tokens.quick-panel-data :as quick-panel-data]
   [cljs.test :as t]))

(t/deftest groups-active-tokens-by-type-and-name
  (let [tokens {"space.large" {:id #uuid "00000000-0000-4000-8000-000000000001"
                               :name "space.large"
                               :type :spacing
                               :value 24}
                "color.text" {:id #uuid "00000000-0000-4000-8000-000000000002"
                              :name "color.text"
                              :type :color
                              :value "#111111"}
                "color.background" {:id #uuid "00000000-0000-4000-8000-000000000003"
                                    :name "color.background"
                                    :type :color
                                    :value "#ffffff"}}
        groups (quick-panel-data/group-active-tokens tokens)]
    (t/is (= [:color :spacing] (mapv :type groups)))
    (t/is (= ["color.background" "color.text"]
             (mapv :name (:tokens (first groups)))))
    (t/is (= ["space.large"]
             (mapv :name (:tokens (second groups)))))))

(t/deftest returns-no-groups-while-active-tokens-are-loading
  (t/is (= [] (quick-panel-data/group-active-tokens nil))))
