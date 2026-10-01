;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.ui.smallpen-ui-helpers-test
  (:require
   [app.common.types.tokens-lib :as ctob]
   [app.main.smallpen.ui.assets :as sp-assets]
   [app.main.smallpen.ui.options :as sp-options]
   [app.main.smallpen.ui.token-modal :as sp-token-modal]
   [app.main.ui.workspace.colorpicker.color-inputs-data :as color-inputs-data]
   [app.main.ui.workspace.tokens.management.forms.controls.utils :as controls-utils]
   [cljs.test :as t :include-macros true]))

(t/deftest assets-filter-offers-graphics-instead-of-colors
  (let [handler identity
        options [{:name "All" :id "all" :handler handler}
                 {:name "Components" :id "components" :handler handler}
                 {:name "Colors" :id "colors" :handler handler}
                 {:name "Typographies" :id "typographies" :handler handler}]
        result  (sp-assets/section-filter-options options)]
    (t/is (= ["all" "components" "graphics" "typographies"] (mapv :id result)))
    (t/is (every? #(= handler (:handler %)) result))))

(t/deftest token-form-targets-the-modal-set-only-when-it-differs
  (let [set-a  (ctob/make-token-set :name "a")
        set-b  (ctob/make-token-set :name "b")
        lib    (-> (ctob/make-tokens-lib)
                   (ctob/add-set set-a)
                   (ctob/add-set set-b))
        a-id   (ctob/get-id set-a)
        b-id   (ctob/get-id set-b)
        tokens {"selected" {:name "selected"}}]
    (t/testing "the selected Set keeps the selected tokens"
      (t/is (= [a-id tokens] (sp-token-modal/target-set a-id a-id tokens lib)))
      (t/is (= [a-id tokens] (sp-token-modal/target-set nil a-id tokens lib))))
    (t/testing "another Set (SmallPen matrix) reads that Set's tokens"
      (t/is (= [b-id {}] (sp-token-modal/target-set b-id a-id tokens lib))))))

(t/deftest centered-token-modal-keeps-inside-owner-bounds
  (let [style (sp-token-modal/centered-style {:top 100 :right 20 :bottom 40 :left 300})]
    (t/is (= "116px" (:top style)))
    (t/is (= "316px" (:left style)))
    (t/is (= "calc(100vh - 172px)" (:maxHeight style))))
  (t/is (= "16px" (:top (sp-token-modal/centered-style nil)))))

(t/deftest design-system-properties-lock
  (let [source     {:plugin-data {:smallpen {"design-system" "source"}}}
        decoration {:plugin-data {:smallpen {"design-system" "decoration"}}}]
    (t/is (false? (boolean (sp-options/properties-locked? false []))))
    (t/is (true? (sp-options/properties-locked? true [])))
    (t/is (true? (boolean (sp-options/properties-locked? true [source decoration]))))
    (t/is (not (sp-options/properties-locked? true [source])))))

(t/deftest token-dropdown-options-stay-upstream-and-color-swatch-is-opt-in
  (let [options @(controls-utils/get-token-dropdown-options
                  {:color [{:id "c1" :name "color.brand" :type :color
                            :value "#7c4dff" :resolved-value "#7c4dff"}]}
                  "")
        token   (some #(when (= :token (:type %)) %) options)]
    (t/is (nil? (:token-type token)))
    (t/is (= :color (->> (color-inputs-data/color-dropdown-options options)
                         (some #(when (= :token (:type %)) %))
                         :token-type)))))
