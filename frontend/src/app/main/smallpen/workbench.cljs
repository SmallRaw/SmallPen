; This Source Code Form is subject to the terms of the Mozilla Public
; License, v. 2.0. If a copy of the MPL was not distributed with this
; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.workbench
  (:require
   [app.main.smallpen :as smallpen]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

;; Every sub-rendering here must be an `mf/defc` element invoked via
;; `[:> ...]`. The rumext v2 compile-time jsx transform only understands the
;; literal hiccup inside a defc body; a plain function returning a hiccup
;; vector would hand a raw CLJS vector to React (error #31).

(defn- color-value?
  [value]
  (and (string? value) (str/starts-with? value "#")))

(defn- row-key
  [row]
  (str (get-in row [:owner :packageId]) ":" (:id row)))

(def ^:private empty-filters
  {:search "" :type "" :owner "" :group ""})

(defn- filters-active?
  [filters]
  (or (seq (:search filters))
      (seq (:type filters))
      (seq (:owner filters))
      (seq (:group filters))))

(defn- token-matches?
  [row {:keys [search type owner group]}]
  (and (or (empty? type) (= type (str (:type row))))
       (or (empty? owner) (= owner (get-in row [:owner :name])))
       (or (empty? group) (= group (str (:group row))))
       (or (empty? search)
           (let [haystack (str/lower-case
                           (str (:path row) " " (:group row) " "
                                (:rawValue row) " " (:resolvedValue row) " "
                                (get-in row [:owner :name])))
                 needle   (str/lower-case search)]
             (str/includes? haystack needle)))))

(defn- distinct-sorted
  [values]
  (->> values (remove nil?) distinct sort))

(mf/defc filter-bar*
  {::mf/props :obj}
  [{:keys [filters on-change types owners groups total shown]}]
  (let [set-filter (fn [key value]
                     (on-change (assoc filters key value)))]
    [:div {:data-testid "workbench-filter-bar"
           :style {:display "flex"
                   :flexWrap "wrap"
                   :gap "8px"
                   :alignItems "center"
                   :marginBottom "12px"}}
     [:input {:data-testid "workbench-search"
              :value (:search filters)
              :placeholder "搜索名称/路径/值"
              :on-change (fn [event]
                           (set-filter :search (.. event -target -value)))
              :style {:flex "1 1 200px"
                      :padding "6px 10px"
                      :borderRadius "6px"
                      :border "1px solid #3f3f46"
                      :backgroundColor "#1f1f23"
                      :color "#e4e4e7"
                      :fontSize "13px"}}]
     [:select {:data-testid "workbench-filter-type"
               :value (:type filters)
               :on-change (fn [event]
                            (set-filter :type (.. event -target -value)))
               :style {:padding "6px" :borderRadius "6px"
                       :border "1px solid #3f3f46"
                       :backgroundColor "#1f1f23"
                       :color "#e4e4e7" :fontSize "12px"}}
      [:option {:value ""} "全部类型"]
      (for [t types]
        [:option {:key t :value t} t])]
     [:select {:data-testid "workbench-filter-owner"
               :value (:owner filters)
               :on-change (fn [event]
                            (set-filter :owner (.. event -target -value)))
               :style {:padding "6px" :borderRadius "6px"
                       :border "1px solid #3f3f46"
                       :backgroundColor "#1f1f23"
                       :color "#e4e4e7" :fontSize "12px"}}
      [:option {:value ""} "全部来源"]
      (for [o owners]
        [:option {:key o :value o} o])]
     [:select {:data-testid "workbench-filter-group"
               :value (:group filters)
               :on-change (fn [event]
                            (set-filter :group (.. event -target -value)))
               :style {:padding "6px" :borderRadius "6px"
                       :border "1px solid #3f3f46"
                       :backgroundColor "#1f1f23"
                       :color "#e4e4e7" :fontSize "12px"}}
      [:option {:value ""} "全部分组"]
      (for [g groups]
        [:option {:key g :value g} g])]
     [:span {:data-testid "workbench-filter-count"
             :style {:color "#a1a1aa" :fontSize "12px"}}
      (str shown "/" total)]
     (when (filters-active? filters)
       [:button {:data-testid "workbench-filter-clear"
                 :on-click (fn [_] (on-change empty-filters))
                 :style {:padding "4px 10px" :borderRadius "6px"
                         :border "1px solid #3f3f46"
                         :backgroundColor "transparent"
                         :color "#a1a1aa" :fontSize "12px"
                         :cursor "pointer"}}
        "清除"])]))

(mf/defc specimen-swatch*
  {::mf/props :obj}
  [{:keys [value]}]
  ;; Decorative preview: never a selection/source target (DSP-005-C).
  (if (color-value? value)
    [:span {:data-testid "specimen-swatch"
            :data-decoration "true"
            :aria-hidden "true"
            :style {:width "100%"
                    :height "44px"
                    :borderRadius "6px"
                    :border "1px solid #52525b"
                    :backgroundColor value
                    :display "block"
                    :pointerEvents "none"}}]
    [:span {:data-testid "specimen-value"
            :data-decoration "true"
            :aria-hidden "true"
            :style {:minHeight "44px"
                    :padding "6px"
                    :borderRadius "6px"
                    :border "1px dashed #52525b"
                    :color "#a1a1aa"
                    :fontFamily "monospace"
                    :fontSize "12px"
                    :display "block"
                    :wordBreak "break-all"
                    :pointerEvents "none"}}
     (str value)]))

(def ^:private typography-status-meta
  {:loading  {:color "#f59e0b" :label "字体加载中…"}
   :ready    {:color "#4ade80" :label "字体就绪"}
   :fallback {:color "#f87171" :label "回退字体"}})

(mf/defc typography-specimen*
  {::mf/props :obj}
  [{:keys [row]}]
  (let [value       (:rawValue row)
        font-id     (str (:fontId value))
        family      (str (or (:fontFamily value) "sans-serif"))
        size        (:fontSize value 16)
        weight      (:fontWeight value 400)
        line        (:lineHeight value 1.4)
        family-name (str "SmallPenWb-" font-id)
        status*     (mf/use-state :loading)
        status      @status*
        meta        (get typography-status-meta status :loading)]
    (mf/use-effect
     (mf/deps font-id)
     (fn []
       (if-not (seq font-id)
         (reset! status* :fallback)
         (let [face (js/FontFace. family-name
                                  (str "url('" (smallpen/font-asset-url font-id) "')"))]
           (.add js/document.fonts face)
           (-> (.load face)
               (.then (fn [_] (reset! status* :ready)))
               (.catch (fn [_] (reset! status* :fallback))))))))
    [:div {:data-testid "typography-specimen"
           :style {:display "flex" :flexDirection "column" :gap "6px"}}
     [:span {:style {:fontFamily (str family-name ", " family ", sans-serif")
                     :fontSize (str size "px")
                     :fontWeight (str weight)
                     :lineHeight (str line)
                     :color "#e4e4e7"
                     :whiteSpace "nowrap"
                     :overflow "hidden"}}
      "设计系统 Aa 123"]
     [:span {:style {:color "#71717a" :fontSize "11px"}}
      (str family " · " size "px · " weight " · " line)]
     [:span {:data-testid "typography-status"
             :style {:color (:color meta) :fontSize "11px"}}
      (str (:label meta) " · " font-id)]]))

(mf/defc specimen-card*
  {::mf/props :obj}
  [{:keys [row selected on-select]}]
  (let [value      (str (or (:resolvedValue row) (:rawValue row)))
        read-only? (boolean (:readOnly row))]
    [:div {:data-testid "specimen-card"
           :data-selected (if selected "true" "false")
           :role "button"
           :tab-index "0"
           :aria-label (str (:path row))
           :on-click (fn [_] (on-select row))
           :on-key-down (fn [event]
                          (when (= (.-key event) "Enter")
                            (on-select row)))
           :style (merge
                   {:padding "10px"
                    :border "1px solid #3f3f46"
                    :borderRadius "8px"
                    :backgroundColor "#1f1f23"
                    :display "flex"
                    :flexDirection "column"
                    :gap "8px"
                    :cursor "pointer"}
                   (when selected
                     {:borderColor "#6750a4"
                      :boxShadow "0 0 0 1px #6750a4"}))}
     (if (and (= "typography" (str (:type row))) (map? (:rawValue row)))
       [:> typography-specimen* {:row row}]
       [:> specimen-swatch* {:value value}])
     [:span {:style {:color "#e4e4e7" :fontSize "12px"
                     :fontFamily "monospace" :wordBreak "break-all"}}
      (str (:path row))]
     [:span {:style {:display "flex" :gap "6px" :alignItems "center"}}
      [:span {:style {:color "#71717a" :fontSize "11px"}}
       (str (or (:type row) "unknown"))]
      (when read-only?
        [:span {:style {:color "#52525b" :fontSize "11px"
                        :border "1px solid #52525b"
                        :borderRadius "4px" :padding "0 4px"}}
         "库"])]]))

(def ^:private numeric-token-types
  #{"border-radius" "spacing" "sizing" "dimension" "number"})

(defn- numeric-token?
  [row]
  (contains? numeric-token-types (str (:type row))))

(def ^:private alias-expression-pattern
  #"^\{[^{}\s]+\}$")

(mf/defc number-editor*
  {::mf/props :obj}
  [{:keys [row on-cancel on-commit pending]}]
  (let [raw       (:rawValue row)
        alias?    (string? raw)
        value*    (mf/use-state (str raw))
        error*    (mf/use-state nil)
        value     @value*
        unit      (if (= "border-radius" (str (:type row))) "px" "px")
        confirm   (fn []
                    (cond
                      alias?
                      (if-not (re-matches alias-expression-pattern value)
                        (reset! error* "alias 表达式必须形如 {token.path}。")
                        (on-commit value))

                      (re-matches #"^-?\d+(\.\d+)?$" value)
                      (do (reset! error* nil)
                          (on-commit (js/parseFloat value)))

                      :else
                      (reset! error* "请输入有效数字。")))]
    [:div {:data-testid "workbench-number-editor"
           :style {:display "flex"
                   :flexDirection "column"
                   :gap "8px"
                   :padding "10px"
                   :border "1px solid #3f3f46"
                   :borderRadius "8px"}}
      [:span {:style {:color "#a1a1aa" :fontSize "12px"}}
       (if alias? "编辑 alias 表达式" "编辑数值定义")]
      [:div {:style {:display "flex" :gap "8px" :alignItems "center"}}
       (if alias?
         [:input {:data-testid "workbench-number-alias"
                  :value value
                  :on-change (fn [event] (reset! value* (.. event -target -value)))
                  :style {:flex "1"
                          :padding "6px 8px"
                          :borderRadius "6px"
                          :border "1px solid #3f3f46"
                          :backgroundColor "#18181b"
                          :color "#e4e4e7"
                          :fontFamily "monospace"
                          :fontSize "12px"}}]
         [:input {:data-testid "workbench-number-value"
                  :type "number"
                  :step "any"
                  :value value
                  :on-change (fn [event] (reset! value* (.. event -target -value)))
                  :style {:flex "1"
                          :padding "6px 8px"
                          :borderRadius "6px"
                          :border "1px solid #3f3f46"
                          :backgroundColor "#18181b"
                          :color "#e4e4e7"
                          :fontFamily "monospace"
                          :fontSize "12px"}}])]
       (when-not alias?
         [:span {:style {:color "#71717a" :fontSize "12px"}} unit])
      (when @error*
        [:p {:data-testid "workbench-edit-error"
             :style {:color "#f87171" :fontSize "12px" :margin "0"}}
         @error*])
      [:div {:style {:display "flex" :gap "8px"}}
       [:button {:data-testid "workbench-edit-confirm"
                 :disabled pending
                 :on-click confirm
                 :style {:padding "4px 12px"
                         :borderRadius "6px"
                         :border "1px solid #6750a4"
                         :backgroundColor "#6750a4"
                         :color "#ffffff"
                         :fontSize "12px"
                         :cursor "pointer"}}
        "确认"]
       [:button {:data-testid "workbench-edit-cancel"
                 :on-click on-cancel
                 :style {:padding "4px 12px"
                         :borderRadius "6px"
                         :border "1px solid #3f3f46"
                         :backgroundColor "transparent"
                         :color "#a1a1aa"
                         :fontSize "12px"
                         :cursor "pointer"}}
        "取消"]]]))

(def ^:private alias-chain-pattern
  #"^\{([^{}]+)\}$")

(defn- token-alias-of
  [row]
  (let [raw (:rawValue row)]
    (when (and (string? raw) (re-matches alias-chain-pattern raw))
      (subs raw 1 (dec (count raw))))))

(defn- edit-targets
  "Explicit edit targets for the selected row (DSP-013-A): owning Cell,
  alias expression, and the alias's shared target Cell."
  [row tokens]
  (let [alias (token-alias-of row)
        base  [{:kind :cell :label "此 Cell" :row row :read-only (boolean (:readOnly row))}]]
    (if-not alias
      base
      (let [target (first (filter #(and (= (str (:path %)) alias)
                                        (not= (:id %) (:id row)))
                                  tokens))]
        (cond-> base
          true (conj {:kind :alias
                      :label "Alias 表达式"
                      :row row
                      :read-only (boolean (:readOnly row))})
          target (conj {:kind :shared
                        :label (str "共享目标 (" alias ")")
                        :row target
                        :read-only (boolean (:readOnly target))}))))))

(def ^:private hex-color-pattern
  #"^#[0-9a-fA-F]{6}$")

(defn- alpha-to-hex
  "0-100 percent -> two uppercase hex digits; 100 omits the alpha channel."
  [alpha]
  (let [clamped (max 0 (min 100 alpha))
        byte    (js/Math.round (/ (* clamped 255) 100))]
    (if (= clamped 100)
      ""
      (let [digits (str/upper-case (.toString byte 16))]
        (if (< byte 16)
          (str "0" digits)
          digits)))))

(defn- node-fill
  "Solid fill color of a projected node, or a neutral placeholder."
  [node]
  (let [fill (first (:fills node))]
    (or (and fill (:color fill)) "#cccccc")))

(defn- node-token-bound
  "Resolve a token-bound field through the loaded token rows so the
  specimen shows the real effective value (DSP-010-A / DSP-013-A)."
  [node field token-rows]
  (let [binding (get (:tokenBindings node) field)]
    (when binding
      (let [id (:assetId binding)]
        (some (fn [row]
                (when (= (:id row) id)
                  {:value (or (:resolvedValue row) (:rawValue row))
                   :token-id id}))
              token-rows)))))

(mf/defc variant-node*
  {::mf/props :obj}
  [{:keys [node token-rows]}]
  (let [bound-radius (node-token-bound node :cornerRadius token-rows)
        radius       (or (:value bound-radius) (:cornerRadius node) 0)]
    [:g {}
     (if (= "ELLIPSE" (str (:type node)))
       [:ellipse {:cx (+ (:x node 0) (/ (:width node 1) 2))
                  :cy (+ (:y node 0) (/ (:height node 1) 2))
                  :rx (/ (:width node 1) 2)
                  :ry (/ (:height node 1) 2)
                  :fill (node-fill node)}]
       [:rect {:x (:x node 0)
               :y (:y node 0)
               :width (:width node)
               :height (:height node)
               :rx radius
               :ry radius
               :fill (node-fill node)}])
     (for [child (:children node)]
       [:> variant-node* {:key (str (:id child))
                          :node child
                          :token-rows token-rows}])]))

(mf/defc component-variant-card*
  {::mf/props :obj}
  [{:keys [variant token-rows read-only]}]
  (let [root      (get (:nodes variant) (keyword (:rootId variant)))
        width     (min 220 (or (:width root) 200))
        height    (or (:height root) 120)
        selection (first (vals (:selection variant)))]
    [:div {:data-testid "component-variant"
           :style {:padding "10px"
                   :border "1px solid #3f3f46"
                   :borderRadius "8px"
                   :backgroundColor "#1f1f23"
                   :display "flex"
                   :flexDirection "column"
                   :gap "8px"}}
     [:svg {:data-testid "component-variant-svg"
            :viewBox (str 0 " " 0 " " (or (:width root) 200) " " height)
            :width width
            :height (* height (/ width (or (:width root) 200)))
            :role "img"
            :aria-label (str (:name variant))}
      [:> variant-node* {:node root :token-rows token-rows}]]
     [:span {:style {:color "#e4e4e7" :fontSize "12px"
                     :fontFamily "monospace"}}
      (str (:name variant))]
     [:span {:style {:display "flex" :gap "6px" :alignItems "center"}}
      (when selection
        [:span {:data-testid "component-variant-axis"
                :style {:color "#71717a" :fontSize "11px"}}
         (str selection)])
      (when read-only
        [:span {:style {:color "#52525b" :fontSize "11px"
                        :border "1px solid #52525b"
                        :borderRadius "4px" :padding "0 4px"}}
         "库"])]]))

(mf/defc component-board*
  {::mf/props :obj}
  [{:keys [components token-rows]}]
  (when (seq components)
    [:div {:data-testid "component-board"
           :style {:marginBottom "24px"}}
     [:h3 {:style {:fontSize "13px" :fontWeight "600"
                   :color "#a1a1aa" :margin "0 0 10px"
                   :textTransform "uppercase"
                   :letterSpacing "0.05em"}}
      "组件"]
     [:div {:style {:display "grid"
                    :gridTemplateColumns "repeat(auto-fill, minmax(200px, 1fr))"
                    :gap "10px"}}
      (for [component components]
        [:div {:key (str (get-in component [:owner :packageId]) ":" (:id component))
               :data-testid "component-set"
               :style {:display "flex" :flexDirection "column" :gap "8px"}}
         [:span {:style {:color "#a1a1aa" :fontSize "12px"}}
          (str (:name component))]
         [:div {:style {:display "flex" :flexWrap "wrap" :gap "8px"}}
          (for [variant (:variants component)]
            [:> component-variant-card*
             {:key (str (:id variant))
              :variant variant
              :token-rows token-rows
              :read-only (boolean (:readOnly component))}])]])]]))

(mf/defc color-editor*
  {::mf/props :obj}
  [{:keys [row on-cancel on-commit pending]}]
  (let [initial    (str (or (:rawValue row) ""))
        base-hex   (subs initial 0 7)
        initial-alpha
        (if (> (.-length initial) 7)
          (js/Math.round (* 100 (/ (js/parseInt (subs initial 7 9) 16) 255)))
          100)
        hex*       (mf/use-state base-hex)
        alpha*     (mf/use-state initial-alpha)
        error*     (mf/use-state nil)
        hex        @hex*
        alpha      @alpha*
        confirm    (fn []
                     (if-not (re-matches hex-color-pattern hex)
                       (reset! error* "颜色格式无效，请使用 #rrggbb。")
                       (do
                         (reset! error* nil)
                         (on-commit (str hex (alpha-to-hex alpha))))))]
    [:div {:data-testid "workbench-color-editor"
           :style {:display "flex"
                   :flexDirection "column"
                   :gap "8px"
                   :padding "10px"
                   :border "1px solid #3f3f46"
                   :borderRadius "8px"}}
      [:span {:style {:color "#a1a1aa" :fontSize "12px"}} "编辑颜色定义"]
      [:div {:style {:display "flex" :gap "8px" :alignItems "center"}}
       [:input {:data-testid "workbench-color-hex"
                :value hex
                :on-change (fn [event] (reset! hex* (.. event -target -value)))
                :style {:flex "1"
                        :padding "6px 8px"
                        :borderRadius "6px"
                        :border "1px solid #3f3f46"
                        :backgroundColor "#18181b"
                        :color "#e4e4e7"
                        :fontFamily "monospace"
                        :fontSize "12px"}}]
       [:span {:data-testid "workbench-color-preview"
               :aria-hidden "true"
               :style {:width "28px" :height "28px"
                       :borderRadius "6px"
                       :border "1px solid #52525b"
                       :backgroundColor (when (re-matches hex-color-pattern hex)
                                          (str hex (alpha-to-hex alpha)))
                       :display "inline-block"}}]]
      [:label {:style {:display "flex" :gap "8px"
                       :alignItems "center" :fontSize "12px"
                       :color "#a1a1aa"}}
       "Alpha %"
       [:input {:data-testid "workbench-color-alpha"
                :type "number"
                :min 0
                :max 100
                :value alpha
                :on-change (fn [event]
                             (let [parsed (js/parseInt (.. event -target -value) 10)]
                               (reset! alpha*
                                       (if (js/isNaN parsed) 0 parsed))))
                :style {:width "64px"
                        :padding "4px 6px"
                        :borderRadius "6px"
                        :border "1px solid #3f3f46"
                        :backgroundColor "#18181b"
                        :color "#e4e4e7"}}]]
      (when @error*
        [:p {:data-testid "workbench-edit-error"
             :style {:color "#f87171" :fontSize "12px" :margin "0"}}
         @error*])
      [:div {:style {:display "flex" :gap "8px"}}
       [:button {:data-testid "workbench-edit-confirm"
                 :disabled pending
                 :on-click confirm
                 :style {:padding "4px 12px"
                         :borderRadius "6px"
                         :border "1px solid #6750a4"
                         :backgroundColor "#6750a4"
                         :color "#ffffff"
                         :fontSize "12px"
                         :cursor "pointer"}}
        "确认"]
       [:button {:data-testid "workbench-edit-cancel"
                 :on-click on-cancel
                 :style {:padding "4px 12px"
                         :borderRadius "6px"
                         :border "1px solid #3f3f46"
                         :backgroundColor "transparent"
                         :color "#a1a1aa"
                         :fontSize "12px"
                         :cursor "pointer"}}
        "取消"]]]))

;; Recursive projected-node renderer: must be a defc (see the note above)
;; so the runtime receives real elements, not raw hiccup vectors.
(mf/defc selection-panel*
  {::mf/props :obj}
  [{:keys [row tokens active-themes editing on-edit commit-error committing
           on-commit on-cancel-edit selected-target on-select-target]}]
  (when row
    (let [read-only?   (boolean (:readOnly row))
          targets      (edit-targets row tokens)
          alias-name   (token-alias-of row)
          alias-target (when alias-name
                         (first (filter #(and (= (str (:path %)) alias-name)
                                              (not= (:id %) (:id row)))
                                        tokens)))
          source     (str (get-in row [:owner :name])
                          "（" (str (get-in row [:owner :role])) "）")
          ;; The observed combination this specimen is shown under: the
          ;; group prefix is the theme domain ("color/light" -> "color").
          combination (get active-themes
                           (first (str/split (str (:group row)) "/")))
          color?     (= "color" (str (:type row)))]
      [:aside {:data-testid "workbench-detail"
               :style {:width "280px"
                       :flexShrink "0"
                       :padding "12px"
                       :border "1px solid #3f3f46"
                       :borderRadius "8px"
                       :backgroundColor "#1f1f23"
                       :alignSelf "flex-start"
                       :position "sticky"
                       :top "12px"
                       :display "flex"
                       :flexDirection "column"
                       :gap "10px"}}
       [:h3 {:style {:margin "0" :fontSize "13px" :color "#f4f4f5"}}
        "样本详情"]
       [:dl {:style {:margin "0" :display "flex"
                     :flexDirection "column" :gap "8px"
                     :fontSize "12px"}}
        [:div
         [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "目标"]
         [:dd {:style {:margin "0" :fontFamily "monospace"
                       :color "#e4e4e7" :wordBreak "break-all"}}
          (str (:path row))]]
        [:div
         [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "来源"]
         [:dd {:data-testid "detail-source"
               :style {:margin "0" :color "#e4e4e7"}}
          source]]
        [:div
         [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "分组"]
         [:dd {:data-testid "detail-group"
               :style {:margin "0" :color "#e4e4e7"}}
          (str (:group row))]]
        (when (seq combination)
          [:div
           [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "组合"]
           [:dd {:data-testid "detail-combination"
                 :style {:margin "0" :color "#e4e4e7"}}
            combination]])
        [:div
         [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "当前值"]
         [:dd {:style {:margin "0" :fontFamily "monospace"
                       :color "#e4e4e7" :wordBreak "break-all"}}
          (str (or (:resolvedValue row) (:rawValue row)))]]
        [:div
         [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "定义 Cell (raw)"]
         [:dd {:data-testid "detail-raw"
               :style {:margin "0" :fontFamily "monospace"
                       :color "#e4e4e7" :wordBreak "break-all"}}
          (str (:rawValue row))]]
        [:div
         [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "Resolved"]
         [:dd {:data-testid "detail-resolved"
               :style {:margin "0" :fontFamily "monospace"
                       :color "#e4e4e7" :wordBreak "break-all"}}
          (str (or (:resolvedValue row) (:rawValue row)))]]
        (when alias-name
          [:div
           [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "Alias 链"]
           [:dd {:data-testid "detail-alias-chain"
                 :style {:margin "0" :color "#e4e4e7"}}
            (str "{"
                 alias-name
                 "} → "
                 (or (some-> alias-target
                             (:resolvedValue)
                             str)
                     "?"))]])
        (when (seq targets)
          [:div
           [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "编辑目标"]
           [:dd {:data-testid "edit-targets"
                 :style {:margin "0" :display "flex" :gap "6px" :flexWrap "wrap"}}
            (for [target targets]
              [:button {:key (str (:kind target))
                        :data-testid (str "edit-target-" (name (:kind target)))
                        :onClick (fn [_] (on-select-target target))
                        :style {:padding "2px 8px"
                                :borderRadius "999px"
                                :fontSize "11px"
                                :cursor "pointer"
                                :border (str "1px solid "
                                             (if (:read-only target)
                                               "#52525b"
                                               "#3f3f46"))
                                :backgroundColor (if (= (:kind target) selected-target)
                                                   "#6750a4" "transparent")
                                :color (if (= (:kind target) selected-target)
                                         "#ffffff" "#a1a1aa")}}
               (str (:label target))])]])
        [:div
         [:dt {:style {:color "#71717a" :margin "0 0 2px"}} "编辑定义"]
         [:dd {:data-testid "detail-edit-state"
               :style {:margin "0"
                       :color (if read-only? "#52525b" "#a5b4fc")}}
          (if read-only?
            "只读来源，不可编辑定义"
            (if (and (or color? (numeric-token? row)) (not editing))
              [:button {:data-testid "workbench-edit-open"
                        :on-click on-edit
                        :style {:padding "2px 10px"
                                :borderRadius "6px"
                                :border "1px solid #6750a4"
                                :backgroundColor "transparent"
                                :color "#a5b4fc"
                                :fontSize "12px"
                                :cursor "pointer"}}
               (if color? "修改颜色" "修改数值")]
              "可编辑定义"))]]]
       (when commit-error
         [:p {:data-testid "workbench-commit-error"
              :style {:color "#f87171" :fontSize "12px" :margin "0"}}
          (str "提交失败：" commit-error)])
       (let [chosen (or (some (fn [target]
                                (when (= (:kind target) selected-target)
                                  (:row target)))
                              targets)
                         row)]
         (cond
           (and (= "color" (str (:type chosen))) (not (:readOnly chosen)) editing)
           [:> color-editor* {:row chosen
                              :pending committing
                              :on-cancel on-cancel-edit
                              :on-commit (fn [value] (on-commit chosen value))}]

           (and (numeric-token? chosen) (not (:readOnly chosen)) editing)
           [:> number-editor* {:row chosen
                               :pending committing
                               :on-cancel on-cancel-edit
                               :on-commit (fn [value] (on-commit chosen value))}]))])))

(mf/defc section-block*
  {::mf/props :obj}
  [{:keys [domain rows selected-key on-select]}]
  [:section {:data-testid "workbench-section"
             :style {:marginBottom "24px"}}
   [:h3 {:style {:fontSize "13px" :fontWeight "600"
                 :color "#a1a1aa" :margin "0 0 10px"
                 :textTransform "uppercase"
                 :letterSpacing "0.05em"}}
    (str domain)]
   [:div {:style {:display "grid"
                  :gridTemplateColumns "repeat(auto-fill, minmax(180px, 1fr))"
                  :gap "10px"}}
    (for [row rows]
      [:> specimen-card* {:key (row-key row)
                          :row row
                          :selected (= (row-key row) selected-key)
                          :on-select on-select}])]])

(mf/defc board*
  {::mf/props :obj}
  [{:keys [tokens selected-key on-select]}]
  (let [sections (->> tokens
                      (group-by #(or (:group %) "ungrouped"))
                      (sort-by first))]
    [:div {:data-testid "workbench-board"
           :style {:flex "1 1 auto"
                   :minWidth "0"}}
     (for [[domain rows] sections]
       [:> section-block* {:key (str domain)
                           :domain domain
                           :rows rows
                           :selected-key selected-key
                           :on-select on-select}])]))

(mf/defc theme-toolbar*
  {::mf/props :obj}
  [{:keys [theme-domains]}]
  (when (seq theme-domains)
    [:div {:data-testid "theme-toolbar"
           :style {:padding "8px 0"
                   :borderBottom "1px solid #3f3f46"
                   :marginBottom "16px"
                   :display "flex"
                   :flexDirection "column"
                   :gap "6px"}}
     (for [{:keys [domain themes]} theme-domains]
       [:div {:key (str domain)
              :style {:display "flex" :alignItems "center"
                      :gap "8px" :flexWrap "wrap"}}
        [:span {:style {:color "#a1a1aa" :fontSize "12px"
                        :minWidth "72px"}}
         (str domain)]
        (for [{:keys [active name themeId]} themes]
          [:span {:key (str themeId)
                  :data-testid (str "theme-" name)
                  :style {:color (if active "#f4f4f5" "#71717a")
                          :backgroundColor (if active "#6750a4" "transparent")
                          :fontSize "12px"
                          :borderRadius "999px"
                          :padding "2px 10px"
                          :border (str "1px solid " (if active "#6750a4" "#3f3f46"))}}
           (str name)])])]))

(defn- active-theme-map
  "domain -> active theme names, for the observed combination display."
  [theme-domains]
  (into {}
        (map (fn [{:keys [domain themes]}]
               [domain (str/join " + " (map :name (filter :active themes)))]))
        theme-domains))

(mf/defc workbench-page*
  {::mf/props :obj}
  [{:keys [file-id]}]
  (let [st         (mf/use-state {:loading true :data nil})
        filters*   (mf/use-state empty-filters)
        selection* (mf/use-state nil)
        editing*   (mf/use-state false)
        target*    (mf/use-state nil)
        commit*    (mf/use-state {:pending false :commit-error nil})
        reload     (fn []
                     (swap! st assoc :loading true :error nil)
                     (-> (smallpen/design-system-workspace)
                         (.then (fn [data]
                                  (swap! st assoc :loading false :data data)))
                         (.catch (fn [cause]
                                   (swap! st assoc :loading false
                                          :error (str cause))))))]
    (mf/use-effect
     (mf/deps file-id)
     (fn []
       (when file-id
         (reload))))
    (let [{:keys [loading error data]} @st
          {:keys [pending commit-error]} @commit*
          filters       @filters*
          selected-key  @selection*
          editing       @editing*
          tokens        (or (:tokens data) [])
          components    (or (:components data) [])
          theme-domains (or (:themeDomains data) [])
          filtered      (filter #(token-matches? % filters) tokens)
          types         (distinct-sorted (map #(str (:type %)) tokens))
          owners        (distinct-sorted (map #(get-in % [:owner :name]) tokens))
          groups        (distinct-sorted (map #(str (:group %)) tokens))
          active-themes (active-theme-map theme-domains)
          ;; The selected row is derived from the live data so the detail
          ;; panel never shows a stale Cell after a committed write.
          selection     (when selected-key
                          (first (filter #(= (row-key %) selected-key) tokens)))
          selected-target (or @target* :cell)
          on-select-target (fn [target]
                             (reset! target* (:kind target))
                             (reset! editing* false)
                             (reset! commit* {:pending false :commit-error nil}))
          on-select     (fn [row]
                          (swap! selection*
                                 (fn [current]
                                   (if (= current (row-key row))
                                     nil
                                     (row-key row))))
                          (reset! editing* false)
                          (reset! target* nil)
                          (reset! commit* {:pending false :commit-error nil}))
          on-commit     (fn [target-row value]
                          (let [row target-row]
                            (swap! commit* assoc :pending true :commit-error nil)
                            (-> (smallpen/commit-operations
                                 {:baseRevision   (:revision data)
                                  :batchId        (str "workbench-" (random-uuid))
                                  :operations
                                  [{:type     "set-token-value"
                                    :filePath (:filePath row)
                                    :path     (:path row)
                                    :tokenId  (:id row)
                                    :value    value}]})
                                (.then (fn [_]
                                         (reset! editing* false)
                                         (swap! commit* assoc :pending false)
                                         (reload)))
                                (.catch (fn [cause]
                                          (swap! commit* assoc :pending false
                                                 :commit-error (str (ex-message cause))))))))]
      [:div {:data-testid "smallpen-workbench"
             :style {:padding "20px 24px"
                     :color "#e4e4e7"
                     :fontFamily "Inter,sans-serif"
                     :minHeight "100vh"
                     :boxSizing "border-box"
                     :overflow "auto"
                     :backgroundColor "#18181b"}}
       [:header {:style {:display "flex"
                         :alignItems "baseline"
                         :gap "12px"
                         :marginBottom "8px"}}
        [:h2 {:style {:fontSize "16px" :fontWeight "600"
                      :color "#f4f4f5" :margin "0"}}
         "设计系统工作台"]
        [:a {:href "#/smallpen"
             :style {:color "#71717a" :fontSize "12px"
                     :textDecoration "none"}}
         "返回首页"]
        [:span {:style {:color "#52525b" :fontSize "12px"}}
         (str "file-id: " (or file-id "-"))]]
       (cond
         error
         [:p {:data-testid "workbench-error"
              :style {:color "#f87171" :fontSize "13px"}}
          (str "加载失败：" error)]

         loading
         [:p {:data-testid "workbench-loading"
              :style {:color "#71717a" :fontSize "13px"}}
          "加载中…"]

         :else
         [:div
          [:> theme-toolbar* {:theme-domains theme-domains}]
          [:> filter-bar* {:filters filters
                           :on-change (fn [next] (reset! filters* next))
                           :types types
                           :owners owners
                           :groups groups
                           :total (count tokens)
                           :shown (count filtered)}]
          [:> component-board* {:components components
                                :token-rows tokens}]
          [:div {:style {:display "flex" :gap "16px" :alignItems "flex-start"}}
           (if (seq filtered)
             [:> board* {:tokens (vec filtered)
                         :selected-key (row-key selection)
                         :on-select on-select}]
             [:p {:data-testid "workbench-empty"
                  :style {:color "#71717a" :fontSize "13px"}}
              (if (filters-active? filters)
                "没有匹配的 Token。"
                "这个 Package 还没有 Token。")])
          [:> selection-panel* {:row selection
                                :tokens tokens
                                :active-themes active-themes
                                :editing editing
                                :on-edit (fn [] (reset! editing* true))
                                :commit-error commit-error
                                :committing pending
                                :on-commit on-commit
                                :on-cancel-edit (fn [] (reset! editing* false))
                                :selected-target selected-target
                                :on-select-target on-select-target}]]])])))
