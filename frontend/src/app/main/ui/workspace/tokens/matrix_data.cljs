;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.tokens.matrix-data
  (:require
   [app.main.smallpen.token-state :as spts]
   [app.common.types.token :as cto]
   [app.common.types.tokens-lib :as ctob]
   [clojure.set :as set]
   [clojure.string :as str]))

(defn compatible-reference-types
  "Returns the token types that can be referenced by an input for `token-type`."
  [token-type]
  (set (or (get cto/tokens-by-input token-type)
           [token-type])))

(defn reference-options
  "Returns compatible token references, deduplicated by name and excluding self."
  ([tokens-lib current-token]
   (reference-options tokens-lib current-token nil))
  ([tokens-lib current-token variant]
   (if (or (nil? tokens-lib) (nil? current-token))
     []
     (let [compatible-types (compatible-reference-types (:type current-token))
           current-name (:name current-token)
           context-tokens
           (when variant
             (reduce
              (fn [tokens token-set]
                (let [set-name (ctob/get-name token-set)]
                  (reduce (fn [tokens token]
                            (assoc tokens (:name token)
                                   {:set-name set-name :token token}))
                          tokens
                          (vals (ctob/get-tokens tokens-lib
                                                 (ctob/get-id token-set))))))
              {}
              (filter #(contains? (:set-names variant) (ctob/get-name %))
                      (ctob/get-sets tokens-lib))))]
       (->> (ctob/get-sets tokens-lib)
            (mapcat #(vals (ctob/get-tokens tokens-lib (ctob/get-id %))))
            (filter #(contains? compatible-types (:type %)))
            (remove #(= current-name (:name %)))
            (reduce (fn [tokens token]
                      (assoc tokens (:name token) token))
                    {})
            vals
            (map (fn [token]
                   (if variant
                     (let [context-token (get context-tokens (:name token))]
                       (assoc token
                              :available-in-variant? (some? context-token)
                              :context-set-name (:set-name context-token)
                              :context-variant-name (:name variant)))
                     token)))
            (sort-by :name)
            vec)))))

(defn filter-reference-options
  [options partial]
  (let [partial (str/lower-case (or partial ""))]
    (if (str/blank? partial)
      options
      (filterv #(str/includes? (str/lower-case (:name %)) partial)
               options))))

(defn with-resolved-values
  "Adds each option's materialized value from the current variant resolution."
  [options resolved-tokens]
  (mapv (fn [option]
          (let [resolved-token (get resolved-tokens (:name option))]
            (if (contains? resolved-token :resolved-value)
              (assoc option :resolved-value (:resolved-value resolved-token))
              option)))
        options))

(defn missing-reference-names
  "Returns reference names that do not exist in any Token Set."
  [tokens-lib value]
  (if (or (nil? tokens-lib) (not (string? value)))
    #{}
    (let [known-names (->> (ctob/get-sets tokens-lib)
                           (mapcat #(keys (ctob/get-tokens tokens-lib
                                                           (ctob/get-id %))))
                           set)]
      (set/difference (cto/find-token-value-references value)
                      known-names))))

(defn complete-reference-opening
  "Replaces the selected range with `{}` and places the cursor between braces."
  [value selection-start selection-end]
  {:value (str (subs value 0 selection-start)
               "{}"
               (subs value selection-end))
   :cursor (inc selection-start)})

(defn- same-name?
  [left right]
  (= (str/lower-case (or left ""))
     (str/lower-case (or right ""))))

(defn next-theme-name
  "Returns Theme, Theme-1, Theme-2, ... without prompting the user."
  [axes]
  (let [names (set (map :name axes))]
    (loop [index 0]
      (let [candidate (if (zero? index) "Theme" (str "Theme-" index))]
        (if (contains? names candidate)
          (recur (inc index))
          candidate)))))

(defn- paired-theme
  [tokens-lib domain-name variant-name set-name]
  (let [candidates (->> (ctob/get-themes tokens-lib)
                        (remove ctob/hidden-theme?)
                        (filter #(contains? (:sets %) set-name))
                        (filter #(same-name? (:group %) domain-name)))
        exact (some #(when (and (= (:group %) domain-name)
                                (= (:name %) variant-name))
                       %)
                    candidates)]
    (or exact
        (when (= 1 (count candidates))
          (first candidates)))))

(defn- set->variant
  [tokens-lib domain-name token-set]
  (let [set-id (ctob/get-id token-set)
        set-name (ctob/get-name token-set)
        path (ctob/get-set-path token-set)
        variant-name (ctob/join-set-path (rest path))
        theme (paired-theme tokens-lib domain-name variant-name set-name)
        theme-id (some-> theme ctob/get-id)]
    {:id set-id
     :name variant-name
     :set-id set-id
     :set-name set-name
     :set-names #{set-name}
     :write-set-id set-id
     :write-set-name set-name
     :theme theme
     :theme-id theme-id
     :theme-name (:name theme)
     :dependency-set-names (disj (or (:sets theme) #{}) set-name)
     :active? (boolean (and theme-id
                            (spts/theme-active? tokens-lib theme-id)))}))

(defn project-axes
  "Projects top-level Token Set Groups and their Sets into matrix domains and
  variants. Themes are paired activation metadata and never provide cell data.

  Root-level Sets are intentionally left to Penpot's native Set UI because a
  matrix column must belong to an explicit domain."
  [tokens-lib]
  (if (nil? tokens-lib)
    []
    (->> (ctob/get-sets tokens-lib)
         (reduce (fn [{:keys [axis-index] :as result} token-set]
                   (let [path (ctob/get-set-path token-set)]
                     (if (< (count path) 2)
                       result
                       (let [domain-name (first path)
                             index (get axis-index domain-name)
                             variant (set->variant tokens-lib domain-name token-set)]
                         (if (some? index)
                           (update-in result [:axes index :variants] conj variant)
                           (-> result
                               (assoc-in [:axis-index domain-name] (count (:axes result)))
                               (update :axes conj {:id domain-name
                                                   :name domain-name
                                                   :group domain-name
                                                   :path [domain-name]
                                                   :variants [variant]})))))))
                 {:axes [] :axis-index {}})
         (:axes)
         (mapv (fn [axis]
                 (let [active-variant (some #(when (:active? %) %) (:variants axis))]
                   (assoc axis
                          :active-variant-id (:id active-variant)
                          :active-theme-id (:theme-id active-variant))))))))

(defn- ordered-variant-sets
  [tokens-lib variant]
  (keep #(ctob/get-set tokens-lib %) [(:set-id variant)]))

(defn- project-cells-from-sets
  [tokens-lib token-sets]
  (reduce
   (fn [cells token-set]
     (let [set-id (ctob/get-id token-set)
           set-name (ctob/get-name token-set)]
       (reduce
        (fn [cells token]
          (let [match {:set-id set-id
                       :set-name set-name
                       :token token}]
            (update cells (:name token)
                    (fn [cell]
                      {:token token
                       :set-id set-id
                       :set-name set-name
                       :matches (conj (or (:matches cell) []) match)
                       :overridden? (some? cell)}))))
        cells
        (vals (ctob/get-tokens tokens-lib set-id)))))
   {}
   token-sets))

(defn- project-variant-cells
  [tokens-lib variant]
  (project-cells-from-sets tokens-lib
                           (ordered-variant-sets tokens-lib variant)))

(defn- ordered-row-names
  [tokens-lib variants]
  (->> variants
       (mapcat #(ordered-variant-sets tokens-lib %))
       (mapcat #(vals (ctob/get-tokens tokens-lib (ctob/get-id %))))
       (map :name)
       distinct
       sort))

(defn- token-definitions
  [tokens-lib variants token-name]
  (keep (fn [token-set]
          (let [set-id (ctob/get-id token-set)]
            (when-let [token (get (ctob/get-tokens tokens-lib set-id) token-name)]
              {:set-id set-id
               :set-name (ctob/get-name token-set)
               :token token})))
        (mapcat #(ordered-variant-sets tokens-lib %) variants)))

(defn project-rows
  "Returns aligned token rows for one projected axis.

  Each cell reads exactly one owned Set. Theme dependency Sets never become
  writable cells, and no Base or fallback Set is inferred."
  [tokens-lib axis]
  (if (or (nil? tokens-lib) (nil? axis))
    []
    (let [variants (:variants axis)
          cells-by-variant (mapv #(project-variant-cells tokens-lib %) variants)]
      (mapv
       (fn [token-name]
         (let [direct-cells (mapv #(get % token-name) cells-by-variant)
               definitions (vec (token-definitions tokens-lib variants token-name))
               token (or (some :token direct-cells)
                         (some-> definitions first :token))
               cells
               (mapv (fn [variant direct-cell]
                       (if direct-cell
                         (assoc direct-cell
                                :template-token token
                                :unset? false
                                :variant variant)
                         {:set-id (:write-set-id variant)
                          :set-name (:write-set-name variant)
                          :template-token token
                          :unset? true
                          :variant variant}))
                     variants
                     direct-cells)]
           {:name token-name
            :type (:type token)
            :definitions definitions
            :cells cells}))
       (ordered-row-names tokens-lib variants)))))

(defn variant-resolution-tokens
  "Returns the token context used to resolve one matrix variant.

  The selected variant replaces the currently active variant for its domain,
  while active Sets from the other domains remain in the resolution context."
  [tokens-lib axis variant]
  (if (or (nil? tokens-lib) (nil? axis) (nil? variant))
    {}
    (let [axis-set-names    (into #{} (map :set-name) (:variants axis))
          active-set-names  (spts/get-active-themes-set-names tokens-lib)
          variant-set-names (or (some-> variant :theme :sets) #{})
          selected-set-names
          (-> active-set-names
              (set/difference axis-set-names)
              (set/union variant-set-names)
              (conj (:set-name variant)))]
      (reduce
       (fn [tokens set-name]
         (if (contains? selected-set-names set-name)
           (if-let [token-set (ctob/get-set-by-name tokens-lib set-name)]
             (merge tokens
                    (ctob/get-tokens tokens-lib (ctob/get-id token-set)))
             tokens)
           tokens))
       {}
       (ctob/get-set-names tokens-lib)))))
