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
   [clojure.string :as str]
   [rumext.v2 :as mf]))

(def ^:private type-labels
  {"boolean" "布尔" "border-radius" "圆角" "color" "颜色" "dimensions" "尺寸（宽高）"
   "font-family" "字体" "font-size" "字号" "font-weight" "字重"
   "letter-spacing" "字距" "number" "数字" "opacity" "不透明度" "other" "其他"
   "rotation" "旋转" "shadow" "阴影" "sizing" "尺寸（高）" "spacing" "间距"
   "string" "字符串" "stroke-width" "描边宽度" "text-case" "大小写"
   "text-decoration" "文本装饰" "typography" "字体排印"})

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
        [:section {:aria-label "组件编辑来源"
                   :style #js {:padding "var(--sp-s)" :fontSize "12px" :overflowWrap "anywhere"
                               :color "var(--color-foreground-primary)" :lineHeight "1.4"}}
         [:strong "组件编辑来源"]
         [:p (str (get ref "familyName" (get ref "componentSetId")) " · "
                  (get ref "combinationLabel" "Source"))]
         [:p (str/join " · " (map (fn [[axis value]] (str axis "=" value)) (get ref "selection")))]
         [:p (str "节点：" (or (get ref "occurrencePath") (get ref "sourceNodeId")))]
         [:p (if (get ref "occurrencePath")
               "范围：当前组件组合内的这个嵌套实例；不修改共享子组件源。"
               "范围：当前组件组合源；未绑定属性会同步到引用它的实例。")]
         (when (seq (get ref "bindings"))
           [:div
            [:p (if (get ref "occurrencePath") "Token 来源（局部覆盖优先）：" "绑定属性修改 Token 源，会影响所有引用此 Token 的组件：")]
            (for [[field binding] (sort-by key (get ref "bindings"))]
              [:p {:key field}
               (str field " → " (get binding "path" "未解析") " = " (raw-string (get binding "value"))
                    (when (or (get binding "alias") (get binding "contextual") (get binding "missing"))
                      " · 请从 Token 区编辑来源"))])])
         [:p {:style #js {:opacity 0.6}} (str "Owner：" (get ref "ownerPackageId"))]]))))

(defn- parse-num
  [text]
  (let [n (js/parseFloat text)]
    (when-not (js/isNaN n) n)))

(defn- alias-shape?
  [text]
  (boolean (re-matches #"^\{[^{}]+\}$" (str/trim (str text)))))

(defn- validate-value
  "Client-side pre-commit diagnosis (R24: 非法值在提交前诊断). Returns
  [error-or-nil parsed-value]. Alias expressions are accepted verbatim."
  [type text]
  (let [trimmed (str/trim (str text))]
    (if (alias-shape? trimmed)
      [nil trimmed]
      (case type
        "boolean"
        (cond
          (= trimmed "true") [nil true]
          (= trimmed "false") [nil false]
          :else ["布尔值只接受 true / false" nil])

        "number"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          [nil n]
          ["数字类型需要一个数值" nil])

        "opacity"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          (if (and (>= n 0) (<= n 1))
            [nil n]
            ["不透明度取值范围 0..1" nil])
          ["不透明度需要一个数值" nil])

        ("dimensions" "sizing" "spacing" "stroke-width" "border-radius")
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          [nil n]
          ["该类型需要一个数值" nil])

        "font-size"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          (if (pos? n)
            [nil n]
            ["字号必须是正数" nil])
          ["字号需要一个数值" nil])

        "letter-spacing"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          [nil n]
          ["字距需要一个数值（可为负）" nil])

        "rotation"
        (if-let [n (and (seq trimmed) (parse-num trimmed))]
          [nil n]
          ["旋转角度需要一个数值（可为负、可超过一圈）" nil])

        "font-weight"
        (cond
          (str/blank? trimmed) ["字重不能为空" nil]
          :else (if-let [n (parse-num trimmed)]
                  [nil n]
                  [nil trimmed]))

        "typography"
        ["排印 Cell 请使用下方字段编辑" nil]

        "other"
        (if-not (seq trimmed)
          ["其他类型需要 JSON 文本" nil]
          (try
            (js/JSON.parse trimmed)
            [nil trimmed]
            (catch :default _
              ["需要合法的 JSON 文本" nil])))

        ;; color / string / font-family / text-case / text-decoration:
        ;; non-empty verbatim text.
        (if (seq (str text))
          [nil (str text)]
          ["值不能为空" nil])))))

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

(def ^:private numeric-field? #{:fontSize :fontWeight :lineHeight :letterSpacing})

(defn- typography-row
  [label field value on-change]
  [:div {:style #js {:display "flex" :gap "6px" :marginBottom "4px" :alignItems "center"}}
   [:span {:style #js {:width "56px" :fontSize "11px" :opacity 0.7}} label]
   [:input {:data-testid (str "dse-typo-" (name field))
            :type "text"
            :default-value (str (or value ""))
            :on-change (fn [event]
                         (let [v (.-value (.-target event))]
                           (on-change field
                                      (if (and (numeric-field? field) (re-matches #"^\s*-?\d+(\.\d+)?\s*$" v))
                                        (js/parseFloat v)
                                        v))))
            :style #js {:color "var(--color-foreground-primary)" :background "var(--color-background-tertiary)" :border "1px solid var(--color-background-quaternary)" :flex "1" :fontSize "12px" :padding "2px 6px"}}]])

(mf/defc token-inspector*
  [{:keys [shapes file-id page-id]}]
  (let [shape     (some (fn [shape] (when (some? (parse-ref shape)) shape))
                        shapes)
        ref       (parse-ref shape)
        type      (get ref "type")
        raw       (get ref "raw")
        alias?    (boolean (get ref "alias"))
        resolved  (get ref "resolved")
        raw-str   (raw-string raw)
        initial   (if (= type "other") raw-str (if (string? raw) raw (raw-string raw)))
        ;; One uncontrolled input per selection: the click handler / change
        ;; handler reads or tracks the current DOM value.
        text-state (mf/use-state initial)
        typo-state (mf/use-state {})
        selection-key (str (:id shape) ":" raw-str)]
    ;; Re-seed the draft when the selection or the stored value changes
    ;; (after undo/reproject the raw value differs).
    (mf/use-effect
     (mf/deps selection-key)
     (fn []
       (reset! text-state initial)
       (reset! typo-state {})))
    (when (and shape ref)
      (let [[validation-error _]
            (if (or alias? (= type "typography"))
              [nil nil]
              (validate-value type @text-state))
            apply-edit
            (fn []
              (let [new-value
                    (if (= type "typography")
                      (let [base  (if (map? raw) raw {})
                            draft @typo-state]
                        (if (empty? draft)
                          nil
                          (clj->js (merge base draft))))
                      @text-state)]
                (when (some? new-value)
                  (commit-token-value! (:id shape) raw new-value file-id page-id))))]
        [:div {:data-testid "dse-token-inspector"
               :style #js {:color "var(--color-foreground-primary)"
                           :borderBottom "1px solid var(--color-background-quaternary)"
                           :padding "10px 12px"
                           :fontSize "12px"}}
         [:div {:style #js {:fontWeight "600" :marginBottom "6px"}}
          "Token · " (or (get ref "path") "?")]
         [:span {:data-testid "dse-token-type"
                 :style #js {:background "var(--color-background-tertiary)"
                             :padding "1px 6px" :borderRadius "4px"
                             :marginBottom "6px" :display "inline-block"}}
          (str (or (get type-labels type) type) " · " type)]
         ;; Technical identity (R18/R26): owner/set/status/Cell id live
         ;; HERE, never on the canvas.
         [:div {:data-testid "dse-token-details"
                :style #js {:color "var(--color-foreground-secondary)"
                            :marginTop "6px" :marginBottom "6px" :lineHeight "1.5"}}
          [:div (str "Token Set：" (get ref "setName"))]
          [:div (str "owner package：" (get ref "ownerPackageId"))]
          [:div (str "Cell ID：" (get ref "tokenId"))]
          [:div (str "状态：" (or (get ref "status") "active")
                     (when (= "archived" (get ref "status")) "（未激活）"))]
          (when alias?
            [:div (str "引用表达式：" raw-str
                       " → 解析值：" (str resolved)
                       (cond
                         (get ref "unresolvedAlias") "（引用未解析）"
                         (get ref "aliasCycle") "（引用成环）"
                         :else ""))])
          (when (get ref "readOnly")
            [:div {:data-testid "dse-token-readonly"}
             "外部只读来源：该 Cell 不能在本页修改"])]
         ;; Editing path (R26): literal Cells edit the value; alias Cells
         ;; rewrite the expression; typography Cells edit single fields.
         (when-not (get ref "readOnly")
           [:div
            (if (= type "typography")
              (let [base (if (map? raw) raw {})]
                [:div
                 [:input {:data-testid "dse-typo-fontFamily"
                          :type "text"
                          :default-value (str (or (get base "fontFamily") (get base :fontFamily) ""))
                          :on-change (fn [event] (swap! typo-state assoc :fontFamily (.-value (.-target event))))
                          :style #js {:color "var(--color-foreground-primary)" :background "var(--color-background-tertiary)" :border "1px solid var(--color-background-quaternary)" :width "100%" :fontSize "12px" :padding "2px 6px" :marginBottom "4px"}}]
                 [:input {:data-testid "dse-typo-fontSize"
                          :type "text"
                          :default-value (str (or (get base "fontSize") (get base :fontSize) ""))
                          :on-change (fn [event] (swap! typo-state assoc :fontSize (js/parseFloat (.-value (.-target event)))))
                          :style #js {:color "var(--color-foreground-primary)" :background "var(--color-background-tertiary)" :border "1px solid var(--color-background-quaternary)" :width "100%" :fontSize "12px" :padding "2px 6px" :marginBottom "4px"}}]
                 [:input {:data-testid "dse-typo-fontWeight"
                          :type "text"
                          :default-value (str (or (get base "fontWeight") (get base :fontWeight) ""))
                          :on-change (fn [event] (swap! typo-state assoc :fontWeight (js/parseFloat (.-value (.-target event)))))
                          :style #js {:color "var(--color-foreground-primary)" :background "var(--color-background-tertiary)" :border "1px solid var(--color-background-quaternary)" :width "100%" :fontSize "12px" :padding "2px 6px" :marginBottom "4px"}}]
                 [:input {:data-testid "dse-typo-lineHeight"
                          :type "text"
                          :default-value (str (or (get base "lineHeight") (get base :lineHeight) ""))
                          :on-change (fn [event] (swap! typo-state assoc :lineHeight (js/parseFloat (.-value (.-target event)))))
                          :style #js {:color "var(--color-foreground-primary)" :background "var(--color-background-tertiary)" :border "1px solid var(--color-background-quaternary)" :width "100%" :fontSize "12px" :padding "2px 6px" :marginBottom "4px"}}]
                 [:input {:data-testid "dse-typo-letterSpacing"
                          :type "text"
                          :default-value (str (or (get base "letterSpacing") (get base :letterSpacing) ""))
                          :on-change (fn [event] (swap! typo-state assoc :letterSpacing (js/parseFloat (.-value (.-target event)))))
                          :style #js {:color "var(--color-foreground-primary)" :background "var(--color-background-tertiary)" :border "1px solid var(--color-background-quaternary)" :width "100%" :fontSize "12px" :padding "2px 6px" :marginBottom "4px"}}]])
              ;; NOTE: boolean/text-case/text-decoration also use the plain
              ;; text input (values validated client- AND adapter-side); the
              ;; previous <select> variant crashed React (#31, keyword child)
              ;; for reasons the other inputs do not trigger.
              [:input {:data-testid "dse-token-value"
                       :type "text"
                       :default-value @text-state
                       :placeholder (if alias? "新的 {引用} 表达式" "新值")
                       :on-change (fn [event]
                                    (reset! text-state (.-value (.-target event))))
                       :style #js {:color "var(--color-foreground-primary)" :background "var(--color-background-tertiary)" :border "1px solid var(--color-background-quaternary)" :width "100%" :fontSize "12px" :padding "2px 6px"
                                   :marginBottom "4px"}}])
            (when alias?
              [:div {:style #js {:color "var(--color-foreground-secondary)" :marginBottom "4px"}}
               (str "该 Cell 是引用：提交将写入新的引用表达式（当前 " raw-str "）")])
            (when validation-error
              [:div {:data-testid "dse-token-error"
                     :style #js {:color "var(--color-accent-error)" :marginBottom "4px"}}
               validation-error])
            [:div {:style #js {:display "flex" :gap "8px" :marginTop "6px"}}
             [:> button* {:data-testid "dse-token-apply"
                          :variant "secondary"
                          :on-click apply-edit}
              "应用到源 Cell"]]])]))))

(mf/defc token-section*
  "Rendered by the options design menu; renders nothing unless the
  selection contains a Token Cell specimen."
  [{:keys [shapes file-id page-id]}]
  (when (some (fn [shape] (some? (parse-ref shape))) shapes)
    [:> token-inspector*
     {:shapes shapes
      :file-id file-id
      :page-id page-id}]))
