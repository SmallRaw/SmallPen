;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.tokens.matrix-data-test
  (:require
   [app.main.smallpen.token-state :as spts]
   [app.common.types.tokens-lib :as ctob]
   [app.main.ui.workspace.tokens.matrix-data :as matrix-data]
   [app.main.ui.workspace.tokens.management.forms.modals :as token-modals]
   [cljs.test :as t]))

(t/deftest centered-token-dialog-has-no-anchor-dependent-offsets
  (doseq [[x y] [[nil nil] [5 20] [1500 800]]
          token-type [:color :typography :number]
          rulers? [true false]]
    (t/is (= {} (#'token-modals/calculate-position
                 {:height 900} :center x y token-type rulers?)))))

(t/deftest anchored-token-dialog-uses-valid-height-calculations
  (t/is (= "calc(100vh - 1rem)"
           (:maxHeight (#'token-modals/calculate-position
                        {:height 900} :right 100 850 :color false))))
  (t/is (= "calc(100vh - 30px)"
           (:maxHeight (#'token-modals/calculate-position
                        {:height 900} :right 100 100 :color false)))))

(defn- token
  [name type value]
  (ctob/make-token :name name :type type :value value))

(defn- token-set
  [name tokens]
  (ctob/make-token-set :name name :tokens (map (juxt :name identity) tokens)))

(defn- sample-lib
  []
  (let [dark-theme (ctob/make-token-theme :group "Mode"
                                          :name "Dark"
                                          :sets #{"Shared/Base" "Mode/Dark"})]
    (-> (ctob/make-tokens-lib)
        (ctob/add-set (token-set "Mode/Light"
                                 [(token "--surface" :color "#ffffff")]))
        (ctob/add-set (token-set "Mode/Dark"
                                 [(token "--accent" :color "#2626d9")
                                  (token "--surface" :color "#171717")]))
        (ctob/add-set (token-set "Device/Mobile"
                                 [(token "--device-accent" :color "#6750a4")
                                  (token "--space-md" :spacing 12)]))
        (ctob/add-set (token-set "Device/Desktop"
                                 [(token "--space-md" :spacing 20)]))
        (ctob/add-set (token-set "Shared/Base"
                                 [(token "--accent" :color "#f4f4f6")
                                  (token "--space-md" :spacing 16)]))
        (ctob/add-theme (ctob/make-token-theme :group "Mode"
                                               :name "Light"
                                               :sets #{"Shared/Base" "Mode/Light"}))
        (ctob/add-theme dark-theme)
        (ctob/add-theme (ctob/make-token-theme :group "Device"
                                               :name "Mobile"
                                               :sets #{"Device/Mobile"}))
        (ctob/add-theme (ctob/make-token-theme :group "Device"
                                               :name "Desktop"
                                               :sets #{"Device/Desktop"}))
        (spts/activate-theme (ctob/get-id dark-theme)))))

(t/deftest tolerates-the-library-loading-state
  (t/is (= [] (matrix-data/project-axes nil)))
  (t/is (= [] (matrix-data/project-rows nil nil))))

(t/deftest creates-theme-names-without-a-naming-step
  (t/is (= "Theme" (matrix-data/next-theme-name [])))
  (t/is (= "Theme-1" (matrix-data/next-theme-name [{:name "Theme"}])))
  (t/is (= "Theme-3"
           (matrix-data/next-theme-name [{:name "Theme"}
                                         {:name "Theme-1"}
                                         {:name "Theme-2"}]))))

(t/deftest projects-set-groups-and-sets-in-library-order
  (let [axes (matrix-data/project-axes (sample-lib))]
    (t/is (= ["Mode" "Device" "Shared"] (mapv :name axes)))
    (t/is (= ["Light" "Dark"] (mapv :name (:variants (first axes)))))
    (t/is (= ["Mobile" "Desktop"] (mapv :name (:variants (second axes)))))
    (t/is (= "Dark" (->> (first axes) :variants (some #(when (:active? %) (:name %))))))))

(t/deftest theme-dependency-sets-do-not-become-editable-cell-sources
  (let [lib (sample-lib)
        axis (first (matrix-data/project-axes lib))
        rows (matrix-data/project-rows lib axis)
        accent-row (first (filter #(= "--accent" (:name %)) rows))
        [light-cell dark-cell] (:cells accent-row)]
    (t/is (= ["--accent" "--surface"]
             (mapv :name rows)))
    (t/is (:unset? light-cell))
    (t/is (= "#2626d9" (-> dark-cell :token :value)))
    (t/is (= "Mode/Dark" (:set-name dark-cell)))
    (t/is (= ["Mode/Dark"] (mapv :set-name (:definitions accent-row))))
    (t/is (= #{"Shared/Base"}
             (-> axis :variants second :dependency-set-names)))))

(t/deftest resolves-each-variant-with-its-theme-dependencies
  (let [lib (sample-lib)
        axis (first (matrix-data/project-axes lib))
        [light-variant dark-variant] (:variants axis)
        light-tokens (matrix-data/variant-resolution-tokens lib axis light-variant)
        dark-tokens (matrix-data/variant-resolution-tokens lib axis dark-variant)]
    (t/is (= "#ffffff" (get-in light-tokens ["--surface" :value])))
    (t/is (= "#171717" (get-in dark-tokens ["--surface" :value])))
    (t/is (= "#f4f4f6" (get-in light-tokens ["--accent" :value])))
    (t/is (nil? (get light-tokens "--device-accent")))))

(t/deftest keeps-a-truly-missing-variant-cell-unset
  (let [lib (sample-lib)
        axis (second (matrix-data/project-axes lib))
        rows (matrix-data/project-rows lib axis)
        accent-row (first (filter #(= "--device-accent" (:name %)) rows))
        [mobile-cell desktop-cell] (:cells accent-row)]
    (t/is (false? (:unset? mobile-cell)))
    (t/is (:unset? desktop-cell))
    (t/is (nil? (:token desktop-cell)))
    (t/is (nil? (:fallback desktop-cell)))
    (t/is (= "Device/Desktop" (:set-name desktop-cell)))))

(t/deftest keeps-definitions-independent-between-variants
  (let [lib (sample-lib)
        axis (second (matrix-data/project-axes lib))
        rows (matrix-data/project-rows lib axis)
        spacing-row (first (filter #(= "--space-md" (:name %)) rows))]
    (t/is (= [12 20]
             (mapv #(-> % :token :value) (:cells spacing-row))))
    (t/is (= ["Device/Mobile" "Device/Desktop"]
             (mapv :set-name (:cells spacing-row))))))

(t/deftest projects-grouped-sets-even-when-the-library-has-no-themes
  (let [lib (-> (ctob/make-tokens-lib)
                (ctob/add-set (token-set "Mode/Light" [(token "--accent" :color "#ffffff")]))
                (ctob/add-set (token-set "Mode/Dark" [(token "--accent" :color "#000000")])))
        axes (matrix-data/project-axes lib)
        rows (matrix-data/project-rows lib (first axes))]
    (t/is (= ["Mode"] (mapv :name axes)))
    (t/is (= ["Light" "Dark"] (mapv :name (:variants (first axes)))))
    (t/is (every? nil? (map :theme-id (:variants (first axes)))))
    (t/is (= ["#ffffff" "#000000"]
             (mapv #(-> % :token :value) (:cells (first rows)))))))

(t/deftest leaves-root-level-sets-outside-the-matrix
  (let [lib (-> (ctob/make-tokens-lib)
                (ctob/add-set (token-set "Light" [(token "--accent" :color "#ffffff")])))]
    (t/is (= [] (matrix-data/project-axes lib)))))

(t/deftest completes-a-reference-opening-around-the-cursor
  (t/is (= {:value "16{}px" :cursor 3}
           (matrix-data/complete-reference-opening "16px" 2 2)))
  (t/is (= {:value "{}" :cursor 1}
           (matrix-data/complete-reference-opening "selected" 0 8))))

(t/deftest distinguishes-missing-references-from-tokens-outside-the-active-variant
  (let [lib (sample-lib)]
    (t/is (= #{}
             (matrix-data/missing-reference-names
              lib
              "{--device-accent}")))
    (t/is (= #{"--does-not-exist"}
             (matrix-data/missing-reference-names
              lib
              "{--surface} {--does-not-exist}")))))

(t/deftest builds-compatible-reference-options-and-excludes-self
  (let [current (token "--space-current" :spacing 8)
        lib (-> (ctob/make-tokens-lib)
                (ctob/add-set
                 (token-set "base"
                            [current
                             (token "--space-small" :spacing 4)
                             (token "--dimension-medium" :dimensions 16)
                             (token "--accent" :color "#ffffff")])))]
    (t/is (= ["--dimension-medium" "--space-small"]
             (mapv :name (matrix-data/reference-options lib current))))
    (t/is (= ["--space-small"]
             (mapv :name
                   (matrix-data/filter-reference-options
                    (matrix-data/reference-options lib current)
                    "space"))))))

(t/deftest reference-options-search-all-sets-and-report-current-variant-status
  (let [lib (sample-lib)
        axis (first (matrix-data/project-axes lib))
        light-variant (first (:variants axis))
        light-set-id (-> (ctob/get-sets lib) first ctob/get-id)
        current (get (ctob/get-tokens lib light-set-id) "--surface")
        options (matrix-data/reference-options lib current light-variant)
        accent (first (filter #(= "--accent" (:name %)) options))
        device-accent (first (filter #(= "--device-accent" (:name %)) options))]
    (t/is (some? accent))
    (t/is (false? (:available-in-variant? accent)))
    (t/is (some? device-accent))
    (t/is (false? (:available-in-variant? device-accent)))))

(t/deftest adds-current-variant-values-to-reference-options
  (let [options [(token "--accent" :color "{--violet}")
                 (token "--space-md" :spacing "{--space-base}")]
        resolved {"--accent" {:resolved-value "#7c4dff"}
                  "--space-md" {:resolved-value 16}}
        result (matrix-data/with-resolved-values options resolved)]
    (t/is (= ["#7c4dff" 16] (mapv :resolved-value result)))))
