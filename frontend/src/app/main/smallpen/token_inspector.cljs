;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.token-inspector
  ;; DSE-R18/R24/R26: the Token section of the native right-side options
  ;; panel. When a generated-page Token Cell specimen is selected it shows
  ;; the technical source identity (owner/set/path/status — never printed on
  ;; the canvas) plus a validated editing path for EVERY canonical type:
  ;; literal Cells edit their value, alias Cells rewrite the "{ref}"
  ;; expression, typography Cells edit individual fields. The edit is one
  ;; ordinary mod-obj change (attr :token-value) through commit-changes, so
  ;; it rides the normal adapter → canonical op → undo pipeline.
  (:require
   [app.main.data.changes :as dch]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.util.i18n :refer [tr]]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

(defn- type-label
  [type]
  (case type
    "boolean" (tr "smallpen.dse.inspector.type.boolean")
    "border-radius" (tr "smallpen.dse.inspector.type.border-radius")
    "color" (tr "smallpen.dse.inspector.type.color")
    "dimensions" (tr "smallpen.dse.inspector.type.dimensions")
    "font-family" (tr "smallpen.dse.inspector.type.font-family")
    "font-size" (tr "smallpen.dse.inspector.type.font-size")
    "font-weight" (tr "smallpen.dse.inspector.type.font-weight")
    "letter-spacing" (tr "smallpen.dse.inspector.type.letter-spacing")
    "number" (tr "smallpen.dse.inspector.type.number")
    "opacity" (tr "smallpen.dse.inspector.type.opacity")
    "other" (tr "smallpen.dse.inspector.type.other")
    "rotation" (tr "smallpen.dse.inspector.type.rotation")
    "shadow" (tr "smallpen.dse.inspector.type.shadow")
    "sizing" (tr "smallpen.dse.inspector.type.sizing")
    "spacing" (tr "smallpen.dse.inspector.type.spacing")
    "string" (tr "smallpen.dse.inspector.type.string")
    "stroke-width" (tr "smallpen.dse.inspector.type.stroke-width")
    "text-case" (tr "smallpen.dse.inspector.type.text-case")
    "text-decoration" (tr "smallpen.dse.inspector.type.text-decoration")
    "typography" (tr "smallpen.dse.inspector.type.typography")
    type))

(defn- parse-ref
  "The source identity the projection stored in the shape's plugin-data as
  JSON (string)."
  [shape]
  (let [pd (some-> shape :plugin-data :smallpen)]
    (when (and (= (get pd "design-system-kind") "token-cell")
               (string? (get pd "design-system-ref")))
      (try
        ;; Keep STRING keys: every accessor in the inspector reads the
        ;; JSON field names ("type", "raw", "ownerPackageId"...).
        (js->clj (js/JSON.parse (get pd "design-system-ref")))
        (catch :default _ nil)))))

(defn- raw-string
  [raw]
  (cond
    (string? raw) raw
    (map? raw) (js/JSON.stringify (clj->js raw))
    :else (str raw)))

(mf/defc component-source-section*
  [{:keys [shapes]}]
  (when (= 1 (count shapes))
    (let [pd (-> shapes first :plugin-data :smallpen)
          ref (when (= "component-definition" (get pd "design-system-kind"))
                (try (js->clj (js/JSON.parse (get pd "design-system-ref")))
                     (catch :default _ nil)))]
      (when ref
        [:section {:aria-label (tr "smallpen.dse.inspector.component-source")
                   :style #js {:padding "var(--sp-s)" :fontSize "12px" :overflowWrap "anywhere"
                               :color "var(--color-foreground-primary)" :lineHeight "1.4"}}
         [:strong (tr "smallpen.dse.inspector.component-source")]
         [:p (str (get ref "familyName" (get ref "componentSetId")) " · "
                  (get ref "combinationLabel" (tr "smallpen.design-system.badge.source")))]
         [:p (str/join " · " (map (fn [[axis value]] (str axis "=" value)) (get ref "selection")))]
         [:p (tr "smallpen.dse.inspector.node" (str (or (get ref "occurrencePath") (get ref "sourceNodeId"))))]
         [:p (if (get ref "occurrencePath")
               (tr "smallpen.dse.inspector.scope-occurrence")
               (tr "smallpen.dse.inspector.scope-source"))]
         (when (seq (get ref "bindings"))
           [:div
            [:p (if (get ref "occurrencePath")
                  (tr "smallpen.dse.inspector.bindings-occurrence")
                  (tr "smallpen.dse.inspector.bindings-source"))]
            (for [[field binding] (sort-by key (get ref "bindings"))]
              [:p {:key field}
               (str field " → " (get binding "path" (tr "smallpen.dse.inspector.unresolved"))
                    " = " (raw-string (get binding "value"))
                    (when (or (get binding "alias") (get binding "contextual") (get binding "missing"))
                      (str " · " (tr "smallpen.dse.inspector.edit-in-tokens"))))])])
         [:p {:style #js {:opacity 0.6}} (tr "smallpen.dse.inspector.owner" (str (get ref "ownerPackageId")))]]))))

(defn- parse-num
  "The whole text as a finite number. parseFloat would accept \"12px\" as
  12 and drop the unit; numeric Cells hold plain numbers."
  [text]
  (let [n (js/Number text)]
    (when (and (not (str/blank? text)) (js/isFinite n))
      n)))

(defn- alias-shape?
  [text]
  (boolean (re-matches #"^\{[^{}]+\}$" (str/trim (str text)))))

(defn- validate-value
  "Client-side pre-commit diagnosis (R24: invalid values are diagnosed
  before commit). Returns [error-or-nil parsed-value]. Alias expressions
  are accepted verbatim."
  [type text]
  (let [trimmed (str/trim (str text))]
    (if (alias-shape? trimmed)
      [nil trimmed]
      (case type
        "boolean"
        (cond
          (= trimmed "true") [nil true]
          (= trimmed "false") [nil false]
          :else [(tr "smallpen.dse.inspector.error.boolean") nil])

        "number"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          [nil n]
          [(tr "smallpen.dse.inspector.error.number") nil])

        "opacity"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          (if (and (>= n 0) (<= n 1))
            [nil n]
            [(tr "smallpen.dse.inspector.error.opacity-range") nil])
          [(tr "smallpen.dse.inspector.error.opacity") nil])

        ("dimensions" "sizing" "spacing" "stroke-width" "border-radius")
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          [nil n]
          [(tr "smallpen.dse.inspector.error.numeric") nil])

        "font-size"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          (if (pos? n)
            [nil n]
            [(tr "smallpen.dse.inspector.error.font-size-positive") nil])
          [(tr "smallpen.dse.inspector.error.font-size") nil])

        "letter-spacing"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          [nil n]
          [(tr "smallpen.dse.inspector.error.letter-spacing") nil])

        "rotation"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          [nil n]
          [(tr "smallpen.dse.inspector.error.rotation") nil])

        "font-weight"
        (cond
          (str/blank? trimmed) [(tr "smallpen.dse.inspector.error.font-weight") nil]
          :else (if-let [n (parse-num trimmed)]
                  [nil n]
                  [nil trimmed]))

        "typography"
        [(tr "smallpen.dse.inspector.error.typography") nil]

        "other"
        (if-not (seq trimmed)
          [(tr "smallpen.dse.inspector.error.other") nil]
          (try
            (js/JSON.parse trimmed)
            [nil trimmed]
            (catch :default _
              [(tr "smallpen.dse.inspector.error.json") nil])))

        ;; color / string / font-family / text-case / text-decoration:
        ;; non-empty verbatim text.
        (if (seq (str text))
          [nil (str text)]
          [(tr "smallpen.dse.inspector.error.empty") nil])))))

(defn- commit-token-value!
  "One ordinary mod-obj change carrying the new Cell value. undo-changes
  restore the previous raw value, so Cmd+Z / Cmd+Shift+Z work through the
  standard undo pipeline (and the adapter compiles both directions into
  set-token-value operations, which re-sync every bound specimen)."
  [shape-id old-raw new-value file-id page-id]
  (st/emit!
   (dch/commit-changes
    {:redo-changes
     [{:type :mod-obj
       :id shape-id
       :page-id page-id
       :operations [{:type :set :attr :token-value :val new-value}]}]
     :undo-changes
     [{:type :mod-obj
       :id shape-id
       :page-id page-id
       :operations [{:type :set :attr :token-value :val old-raw}]}]
     :file-id file-id})))

(def ^:private typography-fields
  "Editable typography fields and the Cell type each one validates as."
  [[:fontFamily "font-family"]
   [:fontSize "font-size"]
   [:fontWeight "font-weight"]
   [:lineHeight "number"]
   [:letterSpacing "letter-spacing"]])

(defn- typography-base
  "The stored typography value with keyword keys. The ref is parsed with
  string keys, and mixing them with the keyword-keyed draft would leave two
  entries per field."
  [raw]
  (if (map? raw)
    (update-keys raw keyword)
    {}))

(defn- field-text
  [value]
  (if (nil? value) "" (str value)))

(defn- initial-text
  [raw]
  (if (string? raw) raw (raw-string raw)))

(defn- validate-typography
  "Validate every edited field as its own Cell type. Fields whose text still
  matches the stored value keep that value untouched. Returns
  [error-or-nil fields-map]."
  [raw draft]
  (let [base (typography-base raw)]
    (reduce
     (fn [[_ value] [field type]]
       (let [text (get draft field)]
         (if (or (nil? text) (= text (field-text (get base field))))
           [nil value]
           (let [[error parsed] (validate-value type text)]
             (if error
               (reduced [(str (name field) ": " error) nil])
               [nil (assoc value field parsed)])))))
     [nil base]
     typography-fields)))

(defn- edited-value
  "Validate the draft against the Cell. Returns [error-or-nil value-or-nil]:
  the value is the parsed one to commit, nil when the draft leaves the Cell
  as stored, so an unedited Apply never rewrites (or retypes) it."
  [type raw alias? text draft]
  (if (and (= type "typography") (not alias?))
    (let [[error value] (validate-typography raw draft)]
      (cond
        error [error nil]
        (= value (typography-base raw)) [nil nil]
        :else [nil (clj->js value)]))
    (let [[error parsed] (validate-value type text)]
      (cond
        error [error nil]
        (= text (initial-text raw)) [nil nil]
        :else [nil parsed]))))

(def ^:private input-style
  #js {:color "var(--color-foreground-primary)" :background "var(--color-background-tertiary)" :border "1px solid var(--color-background-quaternary)" :width "100%" :fontSize "12px" :padding "2px 6px" :marginBottom "4px"})

(mf/defc token-editor*
  "Editing controls for one Cell. The parent keys it by Cell and stored
  value, so selecting another Cell (or an undo that changes the value)
  mounts a fresh editor and no draft leaks from the previous one."
  {::mf/private true}
  [{:keys [shape-id type raw is-alias file-id page-id]}]
  (let [alias?        is-alias
        raw-str       (raw-string raw)
        text-state    (mf/use-state (initial-text raw))
        typo-state    (mf/use-state {})
        typography?   (and (= type "typography") (not alias?))
        [error value] (edited-value type raw alias? @text-state @typo-state)
        apply-edit    (fn []
                        (when (and (nil? error) (some? value))
                          (commit-token-value! shape-id raw value file-id page-id)))]
    [:div
     (if typography?
       (let [base (typography-base raw)]
         [:div
          (for [[field _] typography-fields]
            [:input {:key (name field)
                     :data-testid (str "dse-typo-" (name field))
                     :type "text"
                     :value (get @typo-state field (field-text (get base field)))
                     :on-change (fn [event]
                                  (swap! typo-state assoc field (.-value (.-target event))))
                     :style input-style}])])
       ;; NOTE: boolean/text-case/text-decoration also use the plain
       ;; text input (values validated client- AND adapter-side); the
       ;; previous <select> variant crashed React (#31, keyword child)
       ;; for reasons the other inputs do not trigger.
       [:input {:data-testid "dse-token-value"
                :type "text"
                :value @text-state
                :placeholder (if alias?
                               (tr "smallpen.dse.inspector.alias-placeholder")
                               (tr "smallpen.dse.inspector.value-placeholder"))
                :on-change (fn [event]
                             (reset! text-state (.-value (.-target event))))
                :style input-style}])
     (when alias?
       [:div {:style #js {:color "var(--color-foreground-secondary)" :marginBottom "4px"}}
        (tr "smallpen.dse.inspector.alias-notice" raw-str)])
     (when error
       [:div {:data-testid "dse-token-error"
              :style #js {:color "var(--color-accent-error)" :marginBottom "4px"}}
        error])
     [:div {:style #js {:display "flex" :gap "8px" :marginTop "6px"}}
      [:> button* {:data-testid "dse-token-apply"
                   :variant "secondary"
                   :disabled (or (some? error) (nil? value))
                   :on-click apply-edit}
       (tr "smallpen.dse.inspector.apply")]]]))

(mf/defc token-inspector*
  [{:keys [shapes file-id page-id]}]
  (let [shape    (some (fn [shape] (when (some? (parse-ref shape)) shape))
                       shapes)
        ref      (parse-ref shape)
        type     (get ref "type")
        raw      (get ref "raw")
        alias?   (boolean (get ref "alias"))
        resolved (get ref "resolved")
        raw-str  (raw-string raw)]
    (when (and shape ref)
      [:div {:data-testid "dse-token-inspector"
             :style #js {:color "var(--color-foreground-primary)"
                         :borderBottom "1px solid var(--color-background-quaternary)"
                         :padding "10px 12px"
                         :fontSize "12px"}}
       [:div {:style #js {:fontWeight "600" :marginBottom "6px"}}
        (tr "smallpen.dse.inspector.title" (or (get ref "path") "?"))]
       [:span {:data-testid "dse-token-type"
               :style #js {:background "var(--color-background-tertiary)"
                           :padding "1px 6px" :borderRadius "4px"
                           :marginBottom "6px" :display "inline-block"}}
        (str (type-label type) " · " type)]
       ;; Technical identity (R18/R26): owner/set/status/Cell id live
       ;; HERE, never on the canvas.
       [:div {:data-testid "dse-token-details"
              :style #js {:color "var(--color-foreground-secondary)"
                          :marginTop "6px" :marginBottom "6px" :lineHeight "1.5"}}
        [:div (tr "smallpen.dse.inspector.set" (str (get ref "setName")))]
        [:div (tr "smallpen.dse.inspector.owner-package" (str (get ref "ownerPackageId")))]
        [:div (tr "smallpen.dse.inspector.cell-id" (str (get ref "tokenId")))]
        [:div (if (= "archived" (get ref "status"))
                (tr "smallpen.dse.inspector.status-archived" "archived")
                (tr "smallpen.dse.inspector.status" (or (get ref "status") "active")))]
        (when alias?
          (let [resolution (tr "smallpen.dse.inspector.alias-resolution" raw-str (str resolved))]
            [:div (cond
                    (get ref "unresolvedAlias") (tr "smallpen.design-system.alias-unresolved" resolution)
                    (get ref "aliasCycle") (tr "smallpen.design-system.alias-cycle" resolution)
                    :else resolution)]))
        (when (get ref "readOnly")
          [:div {:data-testid "dse-token-readonly"}
           (tr "smallpen.dse.inspector.read-only")])]
       ;; Editing path (R26): literal Cells edit the value; alias Cells
       ;; rewrite the expression; typography Cells edit single fields.
       (when-not (get ref "readOnly")
         [:> token-editor* {:key (str (:id shape) ":" raw-str)
                            :shape-id (:id shape)
                            :type type
                            :raw raw
                            :is-alias alias?
                            :file-id file-id
                            :page-id page-id}])])))

(mf/defc token-section*
  "Rendered by the options design menu; renders nothing unless the
  selection contains a Token Cell specimen."
  [{:keys [shapes file-id page-id]}]
  (when (some (fn [shape] (some? (parse-ref shape))) shapes)
    [:> token-inspector*
     {:shapes shapes
      :file-id file-id
      :page-id page-id}]))
