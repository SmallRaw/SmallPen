;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.colorpicker.color-inputs-data
  (:require
   [app.common.types.token :as cto]))

(defn reference-value
  [token-name]
  (when (seq token-name)
    (str "{" token-name "}")))

(defn reference-name
  "Returns a token name only when `value` is one complete token reference."
  [value]
  (when (and (string? value)
             (re-matches cto/token-ref-validation-regex value))
    (subs value 1 (dec (count value)))))

(defn display-value
  "Shows the materialized color first while preserving its token relationship."
  [hex token-name]
  (if-let [reference (reference-value token-name)]
    (str hex " (" reference ")")
    hex))

(defn find-reference-token
  [tokens value]
  (when-let [token-name (reference-name value)]
    (some #(when (= token-name (:name %)) %) tokens)))
