;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.colorpicker-reference-input-test
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom/server" :as react-dom]
   [app.main.data.tokenscript :as tokenscript]
   [app.main.ui.ds.controls.shared.options-dropdown :refer [options-dropdown*]]
   [app.main.ui.workspace.colorpicker.color-inputs-data :as data]
   [app.main.ui.workspace.tokens.management.forms.controls.utils :as controls-utils]
   [app.util.globals :as globals]
   [cljs.test :as t]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

(defn- render-token-options
  [options]
  (let [original-document globals/document
        document (.. (JSDOM. "<!doctype html><body></body>") -window -document)
        element (mf/html
                 [:> options-dropdown*
                  {:on-click identity
                   :options options}])]
    (set! globals/document document)
    (try
      (react-dom/renderToStaticMarkup element)
      (finally
        (set! globals/document original-document)))))

(t/deftest displays-the-materialized-color-before-its-reference
  (t/is (= "#7c4dff ({color.brand.primary})"
           (data/display-value "#7c4dff" "color.brand.primary")))
  (t/is (= "#7c4dff" (data/display-value "#7c4dff" nil))))

(t/deftest accepts-only-a-complete-reference-value
  (t/is (= "color.brand.primary"
           (data/reference-name "{color.brand.primary}")))
  (t/is (nil? (data/reference-name "{color.brand.primary")))
  (t/is (nil? (data/reference-name "#7c4dff ({color.brand.primary})"))))

(t/deftest finds-the-selected-reference-token
  (let [tokens [{:id 1 :name "color.brand.primary"}
                {:id 2 :name "color.text.primary"}]]
    (t/is (= 1 (:id (data/find-reference-token tokens "{color.brand.primary}"))))
    (t/is (nil? (data/find-reference-token tokens "{color.missing}")))))

(t/deftest renders-token-reference-options-without-an-option-ref
  (t/is (string? (render-token-options
                  [{:id "color-brand-primary"
                    :type :token
                    :token-type :color
                    :name "color.brand.primary"
                    :value "#7c4dff"
                    :resolved-value "#7c4dff"}]))))

(t/deftest renders-materialized-token-previews
  (let [markup (render-token-options
                [{:id "color-brand-primary"
                  :type :token
                  :token-type :color
                  :name "color.brand.primary"
                  :value "{palette.violet}"
                  :resolved-value "#7c4dff"}
                 {:id "spacing-medium"
                  :type :token
                  :token-type :spacing
                  :name "spacing.medium"
                  :value "{scale.medium}"
                  :resolved-value 16}])]
    (t/is (str/includes? markup "token-option-color-swatch"))
    (t/is (str/includes? markup "#7c4dff"))
    (t/is (str/includes? markup ">16<"))))

(t/deftest renders-tokenscript-number-options-as-plain-values
  (let [resolved-tokens (tokenscript/resolve-tokens
                         {"radius.md" {:id "radius-md"
                                       :name "radius.md"
                                       :type :border-radius
                                       :value 12}})
        options         @(controls-utils/get-token-dropdown-options
                          {:border-radius [(get resolved-tokens "radius.md")]}
                          "")
        option          (some #(when (= :token (:type %)) %) options)]
    (t/is (= 12 (:resolved-value option)))
    (t/is (string? (render-token-options options)))))
