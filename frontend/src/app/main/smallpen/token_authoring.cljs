;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.token-authoring
  "Transport between native TokensLib records and the shared App/CLI planners."
  (:require
   ["smallpen-token-authoring" :as core]
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]))

(defn- token->js
  [token]
  (clj->js (-> (into {} token)
               (dissoc :modified-at)
               (update :id #(when % (str %)))
               (update :type name))))

(defn- sets->js
  [tokens-lib]
  (to-array
   (map (fn [token-set]
          #js {:id (str (ctob/get-id token-set))
               :name (ctob/get-name token-set)
               :tokens (to-array (map token->js
                                      (vals (ctob/get-tokens tokens-lib
                                                             (ctob/get-id token-set)))))})
        (ctob/get-sets tokens-lib))))

(defn- edit->clj
  [^js edit value]
  {:set-id (uuid/parse (.-setId edit))
   :created? (.-created edit)
   :token (-> (js->clj (.-token edit) :keywordize-keys true)
              (assoc :value value)
              (update :id uuid/parse)
              (update :type keyword)
              (ctob/make-token))})

(defn create-row
  [tokens-lib set-ids token]
  (mapv #(edit->clj % (:value token))
        (array-seq (core/createTokenRow (sets->js tokens-lib)
                                        (to-array (map str set-ids))
                                        (token->js token)
                                        #(str (uuid/next))))))

(defn write-cell
  [tokens-lib set-id template value]
  (edit->clj (core/writeTokenCell (sets->js tokens-lib)
                                  (str set-id)
                                  (token->js template)
                                  (clj->js value)
                                  #(str (uuid/next)))
             value))
