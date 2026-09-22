;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.sidebar.assets.tokens-data
  (:require
   [clojure.string :as str]))

(defn- searchable-token-text
  [{:keys [name value resolved-value]}]
  (->> [name value resolved-value]
       (remove nil?)
       (map str)
       (str/join " ")
       (str/lower-case)))

(defn- with-resolution
  [token resolved-tokens]
  (if-let [resolved-token (get resolved-tokens (:name token))]
    (merge token
           (select-keys resolved-token
                        [:resolved-value :errors :warnings :references]))
    token))

(defn effective-token-value
  [token]
  (let [resolved (:resolved-value token)]
    (if (or (nil? resolved)
            (and (coll? resolved) (empty? resolved)))
      (:value token)
      resolved)))

(defn library-token-groups
  "Prepare the active Tokens of an imported library for its read-only Assets
  card. Resolution stays attached to the original value so aliases can show
  both their effective value and their source reference."
  [active-tokens resolved-tokens {:keys [term ordering]}]
  (let [query      (some-> term str/lower-case)
        descending? (= ordering :desc)
        comparator (if descending?
                     #(compare %2 %1)
                     compare)]
    (->> (vals active-tokens)
         (map #(with-resolution % resolved-tokens))
         (filter #(or (str/blank? query)
                      (str/includes? (searchable-token-text %) query)))
         (group-by :type)
         (sort-by (comp name key))
         (mapv (fn [[type tokens]]
                 {:type type
                  :tokens (vec (sort-by :name comparator tokens))})))))
