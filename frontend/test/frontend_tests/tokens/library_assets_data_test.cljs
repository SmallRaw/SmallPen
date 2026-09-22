;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.tokens.library-assets-data-test
  (:require
   [app.main.ui.workspace.sidebar.assets.tokens-data :as tokens-data]
   [cljs.test :as t]))

(def active-tokens
  {"space.small" {:id #uuid "00000000-0000-4000-8000-000000000001"
                  :name "space.small"
                  :type :spacing
                  :value 8}
   "color.brand" {:id #uuid "00000000-0000-4000-8000-000000000002"
                  :name "color.brand"
                  :type :color
                  :value "{palette.brand}"}
   "color.surface" {:id #uuid "00000000-0000-4000-8000-000000000003"
                    :name "color.surface"
                    :type :color
                    :value "#ffffff"}})

(def resolved-tokens
  {"space.small" {:resolved-value 8}
   "color.brand" {:resolved-value "#6750a4"}
   "color.surface" {:resolved-value "#ffffff"}})

(t/deftest prepares-library-tokens-by-type-with-resolved-values
  (let [groups (tokens-data/library-token-groups
                active-tokens
                resolved-tokens
                {:term "" :ordering :asc})]
    (t/is (= [:color :spacing] (mapv :type groups)))
    (t/is (= ["color.brand" "color.surface"]
             (mapv :name (:tokens (first groups)))))
    (t/is (= "#6750a4"
             (-> groups first :tokens first :resolved-value)))
    (t/is (= "{palette.brand}"
             (-> groups first :tokens first :value)))))

(t/deftest searches-name-original-value-and-resolved-value
  (doseq [[term expected]
          [["surface" ["color.surface"]]
           ["palette.brand" ["color.brand"]]
           ["#6750A4" ["color.brand"]]]]
    (let [groups (tokens-data/library-token-groups
                  active-tokens
                  resolved-tokens
                  {:term term :ordering :asc})]
      (t/is (= expected (mapv :name (mapcat :tokens groups)))))))

(t/deftest respects-sidebar-order-and-empty-input
  (let [groups (tokens-data/library-token-groups
                active-tokens
                resolved-tokens
                {:term "" :ordering :desc})]
    (t/is (= ["color.surface" "color.brand"]
             (mapv :name (:tokens (first groups))))))
  (t/is (= [] (tokens-data/library-token-groups nil nil {}))))

(t/deftest falls-back-to-the-original-value-while-resolution-is-empty
  (t/is (= "Inter"
           (tokens-data/effective-token-value
            {:value "Inter" :resolved-value nil})))
  (t/is (= false
           (tokens-data/effective-token-value
            {:value true :resolved-value false})))
  (t/is (= "Inter"
           (tokens-data/effective-token-value
            {:value "Inter" :resolved-value []}))))
