;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.tokens.matrix
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.geom.point :as gpt]
   [app.common.math :as mth]
   [app.common.types.token :as cto]
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.common :as dcm]
   [app.main.data.modal :as modal]
   [app.main.data.style-dictionary :as sd]
   [app.main.data.tinycolor :as tinycolor]
   [app.main.data.tokenscript :as ts]
   [app.main.data.workspace.tokens.application :as dwta]
   [app.main.data.workspace.tokens.errors :as wte]
   [app.main.data.workspace.tokens.format :as dwtf]
   [app.main.data.workspace.tokens.library-edit :as dwtl]
   [app.main.data.workspace.tokens.propagation :as dwtp]
   [app.main.refs :as refs]
   [app.main.smallpen :as smallpen]
   [app.main.store :as st]
   [app.main.ui.components.dropdown-menu :refer [dropdown-menu*
                                                 dropdown-menu-item*]]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.select :refer [select*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.layout.modal :refer [modal-content* modal-header* modal*]]
   [app.main.ui.ds.utilities.swatch :refer [swatch*]]
   [app.main.ui.hooks :as hooks]
   [app.main.ui.workspace.tokens.management :as management]
   [app.main.ui.workspace.tokens.management.context-menu :refer [token-context-menu]]
   [app.main.ui.workspace.tokens.management.forms.controls.token-parsing :as token-parsing]
   [app.main.ui.workspace.tokens.management.forms.validators :as validators]
   [app.main.ui.workspace.tokens.management.group :as group]
   [app.main.ui.workspace.tokens.matrix-data :as matrix-data]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

(def ^:private default-contract
  {:mode :warn
   :prefix "--"
   :separator :hyphen
   :case :kebab})

(def ^:private rename-popover-width 284)
(def ^:private rename-popover-height 284)
(def ^:private popover-viewport-gap 8)

(def ^:private modal-editor-token-types
  #{:font-family :shadow :typography})

(def ^:private token-choice-values
  {:font-weight ["100" "200" "300" "400" "500" "600" "700" "800" "900" "950"]
   :text-case ["none" "uppercase" "lowercase" "capitalize"]
   :text-decoration ["none" "underline" "strike-through"]})

(defn- contract-preview
  [{:keys [prefix separator]}]
  (str prefix
       (case separator
         :dot "color.accent.primary"
         :underscore "color_accent_primary"
         "color-accent-primary")))

(defn- grid-style
  [variant-count]
  #js {"--variant-count" variant-count})

(defn- valid-color?
  [value]
  (and (string? value)
       (not (str/starts-with? value "{"))
       (js/CSS.supports "color" value)))

(defn- color-picker-data
  [value]
  (when-let [color (tinycolor/valid-color value)]
    {:color (tinycolor/->hex-string color)
     :opacity (tinycolor/alpha color)}))

(defn- color-opacity-label
  [opacity expanded]
  (str (if expanded
         (mth/precision (* opacity 100) 2)
         (mth/floor (* opacity 100)))
       "%"))

(defn- color-picker-value
  [original-value {:keys [color opacity]}]
  (when-let [color (tinycolor/valid-color color)]
    (let [original-color (tinycolor/valid-color original-value)
          original-format (some-> original-color tinycolor/color-format)
          opacity (or opacity 1)
          format (cond
                   (and (< opacity 1)
                        (or (nil? original-format)
                            (str/starts-with? original-format "hex")))
                   "rgba"

                   original-format
                   original-format

                   :else
                   "hex")]
      (-> color
          (tinycolor/set-alpha opacity)
          (tinycolor/->string format)))))

(defn- override-title
  [cell]
  (tr "workspace.tokens.matrix.override-warning"
      (str/join ", " (map :set-name (:matches cell)))
      (:set-name cell)))

(defn- coerce-inline-value
  [original-value value]
  (cond
    (number? value)
    value

    (and (number? original-value)
         (string? value)
         (re-matches #"^-?\d+(\.\d+)?$" value))
    (js/Number value)

    (and (boolean? original-value) (string? value))
    (case (str/lower-case value)
      "true" true
      "false" false
      value)

    :else
    value))

(defn- cell-edit-id
  [{:keys [matrix-cell-id set-id token]}]
  (or matrix-cell-id [set-id (:id token)]))

(defn- cell-token
  [cell]
  (or (:token cell) (:template-token cell)))

(defn- token-reference?
  [value]
  (seq (cto/find-token-value-references value)))

(defn- resolved-value-label
  [token resolved-tokens]
  (let [resolved-token (get resolved-tokens (:name token))]
    (when (contains? resolved-token :resolved-value)
      (dwtf/format-token-value (:resolved-value resolved-token)))))

(defn- use-resolved-variant-tokens
  [tokens-by-variant]
  (let [resolved* (mf/use-state tokens-by-variant)]
    (mf/with-effect [tokens-by-variant]
      (reset! resolved* tokens-by-variant)
      (if (contains? cf/flags :tokenscript)
        (do
          (reset! resolved*
                  (reduce-kv (fn [resolved variant-id tokens]
                               (assoc resolved variant-id (ts/resolve-tokens tokens)))
                             {}
                             tokens-by-variant))
          nil)
        (let [subscriptions
              (reduce-kv
               (fn [subscriptions variant-id tokens]
                 (if (seq tokens)
                   (conj subscriptions
                         (rx/sub! (sd/resolve-tokens tokens)
                                  #(swap! resolved* assoc variant-id %)))
                   subscriptions))
               []
               tokens-by-variant)]
          #(run! rx/dispose! subscriptions))))
    @resolved*))

(mf/defc rename-popover*
  {::mf/private true}
  [{:keys [target position value description error on-change
           on-description-change on-close on-save]}]
  (when target
    [:div {:class (stl/css :rename-popover-layer)
           :on-pointer-down (fn [event]
                              (dom/prevent-default event)
                              (on-close))}
     [:form {:class (stl/css :rename-popover)
             :style #js {:left (str (:left position) "px")
                         :top (str (:top position) "px")}
             :aria-labelledby "token-matrix-rename-title"
             :on-pointer-down dom/stop-propagation
             :on-key-down (fn [event]
                            (when (= (.-key event) "Escape")
                              (dom/prevent-default event)
                              (on-close)))
             :on-submit on-save}
      [:h2 {:id "token-matrix-rename-title"
            :class (stl/css :popover-title)}
       (case (:kind target)
         :axis (tr "workspace.tokens.matrix.rename-axis")
         :variant (tr "workspace.tokens.matrix.rename-variant")
         :new-axis (tr "workspace.tokens.matrix.add-axis")
         :token (tr "workspace.tokens.matrix.rename-token"))]
      (when (= :token (:kind target))
        (let [token-target (:target target)]
          [:div {:class (stl/css :rename-token-context)}
           [:span {:class (stl/css :rename-token-type)} (:type-title token-target)]
           [:span (:axis-name token-target)]]))
      [:label {:class (stl/css :field-label)
               :for "token-matrix-rename"}
       (tr "workspace.tokens.matrix.name")]
      [:input {:id "token-matrix-rename"
               :class (stl/css-case :text-input true
                                    :rename-input true
                                    :input-error (some? error))
               :value value
               :auto-focus true
               :on-change on-change}]
      (when (= :token (:kind target))
        [:*
         [:label {:class (stl/css :field-label)
                  :for "token-matrix-description"}
          (tr "workspace.tokens.token-description")]
         [:textarea {:id "token-matrix-description"
                     :class (stl/css :text-input :description-input)
                     :value description
                     :max-length 2048
                     :rows 3
                     :on-change on-description-change}]])
      (when error
        [:div {:class (stl/css :field-error)} error])
      [:div {:class (stl/css :popover-actions)}
       [:> button* {:type "button"
                    :variant "secondary"
                    :on-click on-close}
        (tr "labels.cancel")]
       [:> button* {:type "button"
                    :variant "primary"
                    :on-click on-save
                    :disabled (str/blank? value)}
        (tr "labels.save")]]]]))

(mf/defc pencil-icon*
  {::mf/private true}
  []
  [:svg {:view-box "0 0 16 16"
         :width 16
         :height 16
         :fill "none"
         :aria-hidden true}
   [:path {:d "M10.75 2.25a1.77 1.77 0 0 1 2.5 2.5L5.2 12.8l-3.05.7.7-3.05 7.9-8.2Z"
           :stroke "currentColor"
           :stroke-width 1.25
           :stroke-linecap "round"
           :stroke-linejoin "round"}]
   [:path {:d "m9.5 3.5 3 3"
           :stroke "currentColor"
           :stroke-width 1.25}]])

(mf/defc contract-row*
  {::mf/private true}
  [{:keys [type title global? drafts on-change]}]
  (let [key (if global? [:global :global] [:type type])
        global-contract (merge default-contract (get drafts [:global :global]))
        draft (get drafts key)
        contract (if global?
                   global-contract
                   (merge global-contract (dissoc draft :mode)))
        mode (if global?
               (:mode contract)
               (or (:mode draft) :inherit))]
    [:tr {:class (when global? (stl/css :contract-global-row))}
     [:th {:scope "row"
           :class (stl/css :contract-type-cell)}
      [:span {:class (stl/css :contract-type)}
       [:> icon* {:icon-id (if global?
                             i/tokens
                             (group/token-section-icon type))
                  :size "s"}]
       [:span title]]]
     [:td
      [:select {:class (stl/css :contract-table-select)
                :value (name mode)
                :aria-label (str title " " (tr "workspace.tokens.matrix.contract-mode"))
                :on-change #(on-change key :mode (keyword (dom/get-target-val %)))}
       (when-not global?
         [:option {:value "inherit"}
          (tr "workspace.tokens.matrix.contract.inherit")])
       [:option {:value "open"} (tr "workspace.tokens.matrix.contract.open")]
       [:option {:value "warn"} (tr "workspace.tokens.matrix.contract.warn")]
       [:option {:value "enforce"} (tr "workspace.tokens.matrix.contract.enforce")]]]
     [:td
      [:input {:class (stl/css :contract-table-input)
               :value (:prefix contract)
               :aria-label (str title " " (tr "workspace.tokens.matrix.contract-prefix"))
               :on-change #(on-change key :prefix (dom/get-target-val %))}]]
     [:td
      [:select {:class (stl/css :contract-table-select)
                :value (name (:separator contract))
                :aria-label (str title " " (tr "workspace.tokens.matrix.contract-separator"))
                :on-change #(on-change key :separator (keyword (dom/get-target-val %)))}
       [:option {:value "hyphen"} (tr "workspace.tokens.matrix.separator.hyphen")]
       [:option {:value "dot"} (tr "workspace.tokens.matrix.separator.dot")]
       [:option {:value "underscore"} (tr "workspace.tokens.matrix.separator.underscore")]]]
     [:td
      [:code {:class (stl/css :contract-table-preview)}
       (contract-preview contract)]]]))

(mf/defc contract-drawer*
  {::mf/private true}
  [{:keys [show types drafts on-change on-close]}]
  (when show
    [:aside {:class (stl/css :contract-drawer)}
     [:div {:class (stl/css :drawer-header)}
      [:div
       [:div {:class (stl/css :drawer-eyebrow)}
        (tr "workspace.tokens.matrix.contract")]
       [:h2 {:class (stl/css :drawer-title)}
        (tr "workspace.tokens.matrix.contract.type-table")]]
      [:> icon-button* {:icon i/close
                        :variant "ghost"
                        :aria-label (tr "labels.close")
                        :on-click on-close}]]
     [:p {:class (stl/css :drawer-description)}
      (tr "workspace.tokens.matrix.contract-description")]

     [:div {:class (stl/css :contract-table-scroll)}
      [:table {:class (stl/css :contract-table)}
       [:thead
        [:tr
         [:th {:class (stl/css :contract-table-header-cell)}
          (tr "workspace.tokens.matrix.contract.type-column")]
         [:th {:class (stl/css :contract-table-header-cell)}
          (tr "workspace.tokens.matrix.contract-mode")]
         [:th {:class (stl/css :contract-table-header-cell)}
          (tr "workspace.tokens.matrix.contract-prefix")]
         [:th {:class (stl/css :contract-table-header-cell)}
          (tr "workspace.tokens.matrix.contract-separator")]
         [:th {:class (stl/css :contract-table-header-cell)}
          (tr "workspace.tokens.matrix.contract-preview")]]]
       [:tbody
        [:> contract-row* {:global? true
                           :title (tr "workspace.tokens.matrix.contract.global")
                           :drafts drafts
                           :on-change on-change}]
        (for [type types]
          [:> contract-row* {:key (name type)
                             :type type
                             :title (get-in dwta/token-properties [type :title])
                             :drafts drafts
                             :on-change on-change}])]]]

     [:div {:class (stl/css :draft-note)}
      [:> icon* {:icon-id i/info :size "s"}]
      [:span (tr "workspace.tokens.matrix.contract-draft-note")]]]))

(defn- popup-position
  [node]
  (let [rect (.getBoundingClientRect node)
        width (max 192 (.-width rect))
        max-left (max popover-viewport-gap
                      (- (.-innerWidth js/window) width popover-viewport-gap))]
    {:left (-> (.-left rect)
               (max popover-viewport-gap)
               (min max-left))
     :top (+ (.-bottom rect) 4)
     :width width}))

(mf/defc inline-reference-editor*
  {::mf/private true}
  [{:keys [cell edit reference-options on-change-value on-save-value on-cancel]}]
  (let [input-ref (mf/use-ref nil)
        active-reference* (mf/use-state nil)
        active-index* (mf/use-state 0)
        position* (mf/use-state nil)
        popup-container (hooks/use-portal-container :popup)
        display-value (:value edit)
        options (->> (matrix-data/filter-reference-options
                      reference-options
                      (:partial @active-reference*))
                     (take 8)
                     vec)

        close-options
        (mf/use-fn
         (fn []
           (reset! active-reference* nil)
           (reset! active-index* 0)
           (reset! position* nil)))

        update-options
        (mf/use-fn
         (fn [value cursor]
           (if-let [active-reference
                    (token-parsing/extract-partial-token value cursor)]
             (do
               (reset! active-reference* active-reference)
               (reset! active-index* 0)
               (when-let [node (mf/ref-val input-ref)]
                 (reset! position* (popup-position node))))
             (close-options))))

        restore-cursor
        (mf/use-fn
         (fn [cursor]
           (js/requestAnimationFrame
            (fn []
              (when-let [node (mf/ref-val input-ref)]
                (dom/focus! node)
                (dom/set-selection-range! node cursor cursor))))))

        select-reference
        (mf/use-fn
         (mf/deps display-value on-change-value restore-cursor)
         (fn [option]
           (when-let [node (mf/ref-val input-ref)]
             (let [cursor (dom/selection-start node)
                   {:keys [value cursor]} (cto/insert-ref display-value cursor (:name option))]
               (on-change-value value)
               (close-options)
               (restore-cursor cursor)))))

        on-change
        (mf/use-fn
         (mf/deps on-change-value update-options)
         (fn [event]
           (let [node (dom/get-current-target event)
                 value (dom/get-target-val event)
                 cursor (dom/selection-start node)]
             (on-change-value value)
             (update-options value cursor))))

        on-key-down
        (mf/use-fn
         (mf/deps cell display-value options on-change-value on-save-value on-cancel
                  restore-cursor select-reference)
         (fn [event]
           (let [key (.-key event)
                 options-open? (some? @active-reference*)
                 option-count (count options)]
             (cond
               (and (= key "{")
                    (not (.-metaKey event))
                    (not (.-ctrlKey event))
                    (not (.-altKey event)))
               (let [node (dom/get-current-target event)
                     start (dom/selection-start node)
                     end (dom/selection-end node)
                     {:keys [value cursor]}
                     (matrix-data/complete-reference-opening display-value start end)]
                 (dom/prevent-default event)
                 (on-change-value value)
                 (reset! active-reference* {:start start :end (inc start) :partial ""})
                 (reset! active-index* 0)
                 (reset! position* (popup-position node))
                 (restore-cursor cursor))

               (and options-open? (= key "ArrowDown") (pos? option-count))
               (do
                 (dom/prevent-default event)
                 (swap! active-index* #(mod (inc %) option-count)))

               (and options-open? (= key "ArrowUp") (pos? option-count))
               (do
                 (dom/prevent-default event)
                 (swap! active-index* #(mod (dec %) option-count)))

               (and options-open?
                    (or (= key "Enter") (= key "Tab"))
                    (pos? option-count))
               (do
                 (dom/prevent-default event)
                 (dom/stop-propagation event)
                 (select-reference (nth options @active-index*)))

               (= key "Enter")
               (do
                 (dom/prevent-default event)
                 (dom/stop-propagation event)
                 (on-save-value event cell (dom/get-target-val event)))

               (= key "Escape")
               (do
                 (dom/prevent-default event)
                 (dom/stop-propagation event)
                 (if options-open?
                   (close-options)
                   (on-cancel)))

               :else nil))))]
    (mf/with-effect []
      (let [timeout-id
            (js/setTimeout
             (fn []
               (when-let [node (mf/ref-val input-ref)]
                 (dom/focus! node)
                 (let [cursor (count (dom/get-value node))]
                   (dom/set-selection-range! node cursor cursor))))
             50)]
        #(js/clearTimeout timeout-id)))
    [:*
     [:form {:class (stl/css-case :inline-value-form true
                                  :inline-value-error (some? (:error edit)))
             :title (or (:error edit) display-value)
             :on-submit (fn [event]
                          (on-save-value event cell
                                         (some-> (mf/ref-val input-ref) dom/get-value)))}
      (when (and (= :color (-> cell cell-token :type))
                 (valid-color? display-value))
        [:span {:class (stl/css :color-swatch)
                :style #js {:backgroundColor display-value}}])
      [:input {:ref input-ref
               :class (stl/css :inline-value-input)
               :value display-value
               :role "combobox"
               :aria-autocomplete "list"
               :aria-expanded (boolean @active-reference*)
               :aria-controls "token-matrix-reference-options"
               :aria-label (tr "workspace.tokens.token-value")
               :on-change on-change
               :on-blur (fn [event]
                          (close-options)
                          (on-save-value event cell (dom/get-target-val event)))
               :on-key-down on-key-down}]
      (when-let [error (:error edit)]
        [:span {:class (stl/css :inline-value-warning)
                :title error}
         [:> icon* {:icon-id i/msg-warning :size "s"}]])]
     (when (and @position* @active-reference*)
       (mf/portal
        (mf/html
         [:div {:id "token-matrix-reference-options"
                :class (stl/css :reference-options)
                :style #js {:left (str (:left @position*) "px")
                            :top (str (:top @position*) "px")
                            :width (str (:width @position*) "px")}
                :role "listbox"}
          (if (seq options)
            (for [[index option] (map-indexed vector options)]
              (let [resolved-value (:resolved-value option)
                    resolved-label (when (some? resolved-value)
                                     (dwtf/format-token-value resolved-value))
                    color-data (when (= :color (:type option))
                                 (color-picker-data resolved-value))]
                [:button {:key (str (:id option))
                          :type "button"
                          :role "option"
                          :aria-selected (= index @active-index*)
                          :class (stl/css-case :reference-option true
                                               :reference-option-active
                                               (= index @active-index*))
                          :on-pointer-enter #(reset! active-index* index)
                          :on-pointer-down (fn [event]
                                             (dom/prevent-default event)
                                             (dom/stop-propagation event)
                                             (select-reference option))}
                 [:span {:class (stl/css :reference-option-name)} (:name option)]
                 [:span {:class (stl/css :reference-option-meta)}
                  (if resolved-label
                    [:span {:class (stl/css :reference-option-preview)}
                     (when color-data
                       [:> swatch* {:background color-data
                                    :size "small"
                                    :show-tooltip false}])
                     [:span {:class (stl/css :reference-option-value)}
                      resolved-label]]
                    [:span {:class (stl/css :reference-option-type)}
                     (get-in dwta/token-properties [(:type option) :title])])
                  (when (false? (:available-in-variant? option))
                    [:span {:class (stl/css :reference-option-unset)}
                     (tr "workspace.tokens.matrix.reference-unset"
                         (:context-variant-name option))])]]))
            [:div {:class (stl/css :reference-options-empty)}
             (tr "workspace.tokens.matrix.no-reference-results")])])
        popup-container))]))

(mf/defc choice-value-cell*
  {::mf/private true}
  [{:keys [cell can-edit? choices reference-options on-save]}]
  (let [token (cell-token cell)
        value (if (:token cell)
                (dwtf/format-token-value (:value token))
                "")
        option-values (set choices)
        known-reference-values (into #{} (map #(str "{" (:name %) "}")) reference-options)
        unknown-value? (and (not (contains? option-values value))
                            (not (contains? known-reference-values value)))]
    [:div {:class (stl/css :choice-value-cell)}
     [:select {:class (stl/css :choice-value-select)
               :value value
               :disabled (not can-edit?)
               :aria-label (str (:name token) " " (tr "workspace.tokens.token-value"))
               :on-change #(on-save % cell (dom/get-target-val %))}
      (when (str/blank? value)
        [:option {:value "" :disabled true}
         (tr "workspace.tokens.matrix.unset")])
      (when unknown-value?
        [:option {:value value} value])
      (for [choice choices]
        [:option {:key choice :value choice} choice])
      (when (seq reference-options)
        [:optgroup {:label (tr "workspace.tokens.matrix.reference-options")}
         (for [option reference-options]
           (let [reference (str "{" (:name option) "}")
                 resolved-value (some-> (:resolved-value option)
                                        dwtf/format-token-value)]
             [:option {:key (str (:id option)) :value reference}
              (str reference
                   (when resolved-value
                     (str " · " resolved-value)))]))])]]))

(mf/defc token-value-cell*
  {::mf/private true}
  [{:keys [cell can-edit? edit expanded reference-options resolved-tokens on-start-edit
           on-change-value on-save-value on-save-choice on-open-color on-cancel]}]
  (if-let [token (cell-token cell)]
    (let [cell-id (cell-edit-id cell)
          editing? (= cell-id (:id edit))
          defined? (some? (:token cell))
          value (when defined? (dwtf/format-token-value (:value token)))
          reference? (boolean (token-reference? (:value token)))
          resolved-value (when reference?
                           (resolved-value-label token resolved-tokens))
          displayed-value (or resolved-value value)
          resolved-reference-options
          (matrix-data/with-resolved-values reference-options resolved-tokens)
          color-data (when (and defined? (= :color (:type token)))
                       (color-picker-data displayed-value))
          value-title (if resolved-value
                        (str resolved-value " · " value)
                        value)
          choices (get token-choice-values (:type token))]
      (cond
        (and choices (or defined? editing?))
        [:> choice-value-cell* {:cell cell
                                :can-edit? can-edit?
                                :choices choices
                                :reference-options resolved-reference-options
                                :on-save on-save-choice}]

        editing?
        [:> inline-reference-editor* {:cell cell
                                      :edit edit
                                      :reference-options resolved-reference-options
                                      :on-change-value on-change-value
                                      :on-save-value on-save-value
                                      :on-cancel on-cancel}]

        color-data
        [:button {:type "button"
                  :class (stl/css :value-cell :color-value-button)
                  :title value-title
                  :aria-label (str (:name token) " " value-title)
                  :disabled (not can-edit?)
                  :on-click #(on-open-color % cell displayed-value value
                                            resolved-reference-options)}
         [:span {:class (stl/css :color-swatch)
                 :style #js {:backgroundColor (:color color-data)}}]
         (if reference?
           [:*
            [:span {:class (stl/css :color-value-hex)}
             (:color color-data)]
            [:span {:class (stl/css :reference-value-text)}
             (str "(" value ")")]]
           [:*
            [:span {:class (stl/css :color-value-hex)}
             (:color color-data)]
            [:span {:class (stl/css :color-value-divider)
                    :aria-hidden true}]
            [:span {:class (stl/css :color-value-opacity)}
             (color-opacity-label (:opacity color-data) expanded)]])
         (when (:overridden? cell)
           [:span {:class (stl/css :override-warning)
                   :title (override-title cell)}
            [:> icon* {:icon-id i/msg-warning :size "s"}]])]

        defined?
        [:div {:class (stl/css :value-cell)
               :title value-title}
         [:button {:type "button"
                   :class (stl/css :value-edit-button)
                   :disabled (not can-edit?)
                   :on-pointer-down #(on-start-edit % cell)}
          (if resolved-value
            [:*
             [:span {:class (stl/css :resolved-value-text)} resolved-value]
             [:span {:class (stl/css :reference-value-text)} value]]
            [:span {:class (stl/css :value-text)} value])
          (when (:overridden? cell)
            [:span {:class (stl/css :override-warning)
                    :title (override-title cell)}
             [:> icon* {:icon-id i/msg-warning :size "s"}]])]]

        :else
        [:button {:type "button"
                  :class (stl/css :empty-cell :empty-cell-button)
                  :disabled (or (not can-edit?) (nil? (:set-id cell)))
                  :aria-label (tr "workspace.tokens.matrix.set-value"
                                  (:name token)
                                  (-> cell :variant :name))
                  :title (tr "workspace.tokens.matrix.unset")
                  :on-pointer-down #(on-start-edit % cell)}
         "—"]))
    [:div {:class (stl/css :empty-cell)} "—"]))

(mf/defc combination-dialog*
  [{:keys [axes show on-change on-close]}]
  [:> modal* {:class (stl/css :combination-dialog)
              :is-open show
              :on-open-change #(when-not % (on-close))
              :size "small"}
   [:> modal-header* {:title (tr "workspace.tokens.matrix.current-combination")}]
   [:> modal-content* {:class (stl/css :combination-dialog-content)}
    [:div {:class (stl/css :combination-dialog-list)}
     (for [{:keys [id name variants] :as axis} axes
           :let [active-variant (or (some #(when (:active? %) %) variants)
                                    (first variants))
                 options (mapv (fn [variant]
                                 {:id (str (:id variant))
                                  :label (:name variant)})
                               variants)]]
       [:div {:key (str "combination-" id)
              :class (stl/css :combination-dialog-row)}
        [:span {:class (stl/css :combination-dialog-domain)} name]
        [:> select* {:options options
                     :default-selected (some-> active-variant :id str)
                     :wrapper-class (stl/css :combination-dialog-select)
                     :aria-label (tr "workspace.tokens.matrix.current-domain" name)
                     :on-change #(on-change % axis)}]])]]])

(mf/defc token-matrix*
  [{:keys [tokens-lib initial-expanded show-expand-action on-close]
    :or {initial-expanded false
         show-expand-action true}}]
  (let [user-can-edit? (mf/use-ctx ctx/can-edit?)
        read-only? (mf/use-ctx ctx/workspace-read-only?)
        can-edit? (and user-can-edit? (not read-only?))
        selected-token-set-id (mf/deref refs/selected-token-set-id)
        axes (mf/with-memo [tokens-lib]
               (matrix-data/project-axes tokens-lib))

        active-axis-id* (mf/use-state #(some-> axes first :id))
        active-axis-id (deref active-axis-id*)
        active-axis (or (some #(when (= (:id %) active-axis-id) %) axes)
                        (first axes))
        variants (:variants active-axis)
        rows (mf/with-memo [tokens-lib active-axis]
               (if active-axis
                 (matrix-data/project-rows tokens-lib active-axis)
                 []))
        tokens-by-variant
        (mf/with-memo [tokens-lib active-axis]
          (into {}
                (map (fn [variant]
                       [(:id variant)
                        (matrix-data/variant-resolution-tokens
                         tokens-lib
                         active-axis
                         variant)]))
                variants))
        resolved-tokens-by-variant
        (use-resolved-variant-tokens tokens-by-variant)

        expanded* (mf/use-state initial-expanded)
        expanded? (deref expanded*)
        panel-ref (mf/use-ref nil)
        axis-menu* (mf/use-state nil)
        axis-menu-position* (mf/use-state nil)
        variant-menu* (mf/use-state nil)
        add-menu* (mf/use-state nil)
        combination-open* (mf/use-state false)
        contract-open* (mf/use-state false)
        contract-drafts* (mf/use-state {})
        context-row* (mf/use-state nil)
        rename-target* (mf/use-state nil)
        rename-value* (mf/use-state "")
        rename-description* (mf/use-state "")
        rename-error* (mf/use-state nil)
        inline-edit*          (mf/use-state nil)
        previous-can-edit-ref (mf/use-ref can-edit?)
        popup-container       (hooks/use-portal-container :popup)
        addable-token-types   (first (management/get-sorted-token-groups {}))

        close-panel
        (mf/use-fn
         (mf/deps expanded? on-close)
         (fn []
           (cond
             on-close
             (on-close)

             expanded?
             (reset! expanded* false)

             :else
             (st/emit! (dcm/go-to-workspace :layout :layers)))))

        add-variant
        (mf/use-fn
         (mf/deps active-axis variants)
         (fn [event]
           (when-let [{:keys [write-set-id]} (first variants)]
             (dom/stop-propagation event)
             (st/emit! (dwtl/duplicate-token-matrix-variant
                        (:name active-axis)
                        write-set-id)))))

        open-rename
        (mf/use-fn
         (fn [event kind target]
           (dom/prevent-default event)
           (dom/stop-propagation event)
           (reset! axis-menu* nil)
           (reset! variant-menu* nil)
           (reset! rename-error* nil)
           (reset! rename-value* (:name target))
           (reset! rename-description* (or (:description target) ""))
           (let [rect (.getBoundingClientRect (dom/get-current-target event))
                 max-left (max popover-viewport-gap
                               (- (.-innerWidth js/window)
                                  rename-popover-width
                                  popover-viewport-gap))
                 left (-> (.-left rect)
                          (max popover-viewport-gap)
                          (min max-left))
                 below (+ (.-bottom rect) 4)
                 above (- (.-top rect) rename-popover-height 4)
                 top (if (<= (+ below rename-popover-height)
                             (- (.-innerHeight js/window) popover-viewport-gap))
                       below
                       (max popover-viewport-gap above))]
             (reset! rename-target* {:kind kind
                                     :target target
                                     :position {:left left :top top}}))))

        close-rename
        (mf/use-fn
         (fn []
           (reset! rename-target* nil)
           (reset! rename-error* nil)))

        open-add-axis
        (mf/use-fn
         (mf/deps axes)
         (fn [event]
           (dom/prevent-default event)
           (dom/stop-propagation event)
           (let [name (matrix-data/next-theme-name axes)]
             (st/emit! (dwtl/create-token-matrix-domain name))
             (reset! active-axis-id* name))))

        change-combination
        (mf/use-fn
         (fn [value axis]
           (when-let [variant (some #(when (= (str (:id %)) value) %)
                                    (:variants axis))]
             (st/emit! (dwtl/activate-token-matrix-variant
                        (:name axis)
                        (:set-id variant))))))

        save-rename
        (mf/use-fn
         (mf/deps tokens-lib
                  axes
                  active-axis
                  rename-target*
                  rename-value*
                  rename-description*)
         (fn [event]
           (dom/prevent-default event)
           (let [{:keys [kind target]} @rename-target*
                 new-name (str/trim @rename-value*)
                 new-description (str/trim @rename-description*)
                 name-changed? (not= new-name (:name target))
                 description-changed? (not= new-description (:description target))
                 conflicts?
                 (case kind
                   :axis
                   (some #(and (not= (:id %) (:id target))
                               (= (:name %) new-name))
                         axes)

                   :new-axis
                   (some #(= (:name %) new-name) axes)

                   :variant
                   (some #(and (not= (:id %) (:id target))
                               (= (:name %) new-name))
                         (:variants active-axis))

                   :token
                   (some (fn [{:keys [set-id token]}]
                           (when-let [existing (get (ctob/get-tokens tokens-lib set-id)
                                                    new-name)]
                             (not= (ctob/get-id existing) (ctob/get-id token))))
                         (:definitions target))

                   false)]
             (cond
               (str/blank? new-name)
               (reset! rename-error* (tr "workspace.tokens.matrix.rename-empty"))

               (and (contains? #{:axis :variant :new-axis} kind)
                    (str/includes? new-name "/"))
               (reset! rename-error* (tr "workspace.tokens.matrix.rename-separator"))

               conflicts?
               (reset! rename-error* (tr "workspace.tokens.matrix.rename-conflict"))

               (and (= kind :token)
                    (not name-changed?)
                    (not description-changed?))
               (close-rename)

               (= kind :axis)
               (do
                 (st/emit! (dwtl/rename-token-matrix-domain
                            (:path target)
                            new-name))
                 (reset! active-axis-id* new-name)
                 (close-rename))

               (= kind :variant)
               (do
                 (st/emit! (dwtl/rename-token-matrix-variant
                            (:name active-axis)
                            (:set-id target)
                            new-name))
                 (close-rename))

               (= kind :new-axis)
               (do
                 (st/emit! (dwtl/create-token-matrix-domain new-name))
                 (reset! active-axis-id* new-name)
                 (close-rename))

               (= kind :token)
               (do
                 (when name-changed?
                   (st/emit! (dwtl/toggle-nested-token-path (:type target) new-name)))
                 (st/emit! (dwtl/update-token-matrix-row
                            (:definitions target)
                            {:name new-name
                             :description new-description}))
                 (close-rename))))))

        confirm-delete-axis
        (mf/use-fn
         (fn [axis]
           (reset! axis-menu* nil)
           (st/emit!
            (modal/show {:type :confirm
                         :title (tr "workspace.tokens.matrix.delete-axis")
                         :message (tr "workspace.tokens.matrix.delete-axis-message" (:name axis))
                         :accept-label (tr "labels.delete")
                         :on-accept #(st/emit!
                                      (dwtl/delete-token-matrix-domain
                                       (:path axis)))}))))

        confirm-delete-variant
        (mf/use-fn
         (fn [variant]
           (reset! variant-menu* nil)
           (st/emit!
            (modal/show {:type :confirm
                         :title (tr "workspace.tokens.matrix.delete-variant")
                         :message (tr "workspace.tokens.matrix.delete-variant-message" (:name variant))
                         :accept-label (tr "labels.delete")
                         :on-accept #(st/emit!
                                      (dwtl/delete-token-matrix-variant
                                       (:name active-axis)
                                       (:set-id variant)))}))))

        open-contracts
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! contract-open* true)))

        change-contract
        (mf/use-fn
         (fn [key field value]
           (swap! contract-drafts* assoc-in [key field] value)))

        start-inline-edit
        (mf/use-fn
         (mf/deps active-axis can-edit? inline-edit*)
         (fn [event {:keys [set-id] :as cell}]
           (let [token (cell-token cell)
                 defined? (some? (:token cell))]
             (when (and can-edit? token set-id)
               (dom/prevent-default event)
               (dom/stop-propagation event)
               (if (contains? modal-editor-token-types (:type token))
                 (let [{:keys [modal]} (dwta/get-token-properties token)
                       {:keys [key fields]} modal
                       modal-token (if defined?
                                     token
                                     (select-keys token [:name :type :value :description]))]
                   (reset! inline-edit* nil)
                   (st/emit!
                    (modal/show key {:position :center
                                     :owner-bounds (let [rect (.getBoundingClientRect (mf/ref-val panel-ref))]
                                                     {:top (.-top rect) :left (.-left rect)
                                                      :right (- js/window.innerWidth (.-right rect))
                                                      :bottom (- js/window.innerHeight (.-bottom rect))})
                                     :fields fields
                                     :action (if defined? "edit" "create")
                                     :selected-token-set-id set-id
                                     :value-only? true
                                     :value-context {:domain (:name active-axis)
                                                     :variant (-> cell :variant :name)}
                                     :token modal-token})))
                 (reset! inline-edit* {:id (cell-edit-id cell)
                                       :value (if defined?
                                                (dwtf/format-token-value (:value token))
                                                "")
                                       :original-value (when defined? (:value token))
                                       :coercion-value (:value token)
                                       :saving? false
                                       :error nil}))))))

        change-inline-value
        (mf/use-fn
         (mf/deps inline-edit*)
         (fn [value]
           (swap! inline-edit* assoc
                  :value value
                  :error nil)))

        cancel-inline-edit
        (mf/use-fn
         (mf/deps inline-edit*)
         (fn []
           (reset! inline-edit* nil)))

        persist-inline-value
        (mf/use-fn
         (mf/deps inline-edit* tokens-lib)
         (fn [{:keys [set-id] :as cell} raw-value]
           (let [token (cell-token cell)
                 defined-token (:token cell)
                 cell-id (cell-edit-id cell)
                 active? (= cell-id (:id @inline-edit*))
                 value (coerce-inline-value (or (:value defined-token)
                                                (:coercion-value @inline-edit*)
                                                (:value token))
                                            raw-value)
                 value-text (str/trim (dwtf/format-token-value value))
                 original-text (when defined-token
                                 (dwtf/format-token-value (:value defined-token)))
                 missing-reference (first (matrix-data/missing-reference-names
                                           tokens-lib
                                           value-text))
                 validation-error
                 (or (validators/check-empty-value {:value value-text})
                     (validators/check-self-reference (:name token) value-text))
                 error-message
                 (if missing-reference
                   (tr "workspace.tokens.matrix.reference-missing" missing-reference)
                   (when validation-error
                     (or (first (wte/humanize-errors [validation-error]))
                         (tr "errors.generic"))))]
             (cond
               (and (nil? defined-token) (str/blank? value-text))
               (when active?
                 (reset! inline-edit* nil))

               (= value-text original-text)
               (when active?
                 (reset! inline-edit* nil))

               error-message
               (when active?
                 (swap! inline-edit* assoc
                        :saving? false
                        :error error-message))

               :else
               (do
                 (when active?
                   (swap! inline-edit* assoc :saving? true :error nil))
                 (let [undo-group (uuid/next)]
                   (st/emit! (if defined-token
                               (dwtl/update-token
                                set-id
                                (:id defined-token)
                                {:value value}
                                :undo-group undo-group)
                               (dwtl/create-token
                                set-id
                                (ctob/make-token
                                 {:name (:name token)
                                  :type (:type token)
                                  :value value
                                  :description (:description token)})
                                :undo-group undo-group))
                             (dwtp/propagate-workspace-tokens undo-group)))
                 (when (= cell-id (:id @inline-edit*))
                   (reset! inline-edit* nil)))))))

        save-inline-raw-value
        (mf/use-fn
         (mf/deps persist-inline-value)
         (fn [event cell value]
           (when event
             (dom/prevent-default event)
             (dom/stop-propagation event))
           (persist-inline-value cell value)))

        save-choice-value
        (mf/use-fn
         (mf/deps persist-inline-value)
         (fn [event cell value]
           (dom/prevent-default event)
           (dom/stop-propagation event)
           (persist-inline-value cell value)))

        open-inline-color
        (mf/use-fn
         (mf/deps persist-inline-value)
         (fn [event cell displayed-value raw-value reference-options]
           (when-let [data (color-picker-data displayed-value)]
             (dom/prevent-default event)
             (dom/stop-propagation event)
             (let [{:keys [x y]} (dom/get-client-position event)
                   reference-name (first (cto/find-token-value-references raw-value))]
               (modal/show!
                :colorpicker
                {:x x
                 :y y
                 :position :right
                 :origin :sidebar
                 :disable-gradient true
                 :disable-image true
                 :data data
                 :applied-token reference-name
                 :reference-tokens reference-options
                 :on-reference-accept #(persist-inline-value cell %)
                 :on-accept (fn [color]
                              (when-let [value (color-picker-value displayed-value color)]
                                (persist-inline-value cell value)))})))))

        open-token-rename
        (mf/use-fn
         (mf/deps active-axis)
         (fn [event {:keys [name type definitions]}]
           (reset! add-menu* nil)
           (st/emit! (dwtl/assign-token-context-menu nil))
           (let [description (or (some-> definitions first :token :description) "")]
             (open-rename event
                          :token
                          {:name name
                           :description description
                           :type type
                           :type-title (get-in dwta/token-properties [type :title])
                           :axis-name (:name active-axis)
                           :definitions definitions}))))

        open-token-menu
        (mf/use-fn
         (fn [event row]
           (dom/prevent-default event)
           (dom/stop-propagation event)
           (when-let [{:keys [token set-id]} (some #(when (:token %) %) (:cells row))]
             (reset! add-menu* nil)
             (let [target (dom/get-current-target event)
                   rect (.getBoundingClientRect target)
                   x (max 8 (- (.-left rect) 244))
                   y (min (.-top rect) (- (.-innerHeight js/window) 180))]
               (reset! context-row* row)
               (st/emit!
                (when (not= selected-token-set-id set-id)
                  (dwtl/set-selected-token-set-id set-id))
                (dwtl/assign-token-context-menu
                 {:type :token
                  :position (gpt/point x y)
                  :token-id (:id token)}))))))

        toggle-axis-menu
        (mf/use-fn
         (fn [event id]
           (dom/prevent-default event)
           (dom/stop-propagation event)
           (let [rect (.getBoundingClientRect (dom/get-current-target event))]
             (reset! axis-menu-position*
                     {:left (max popover-viewport-gap
                                 (min (.-left rect) (- (.-innerWidth js/window) 200)))
                      :top (+ (.-bottom rect) popover-viewport-gap)})
             (reset! axis-menu* (when-not (= @axis-menu* id) id)))))

        toggle-add-menu
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (if @add-menu*
             (reset! add-menu* nil)
             (let [_ (st/emit! (dwtl/assign-token-context-menu nil))
                   rect (.getBoundingClientRect (dom/get-current-target event))
                   left (-> (.-left rect)
                            (max 8)
                            (min (- (.-innerWidth js/window) 232)))
                   top (+ (.-bottom rect) popover-viewport-gap)]
               (reset! add-menu* {:left left :top top})))))

        delete-context-token
        (mf/use-fn
         (fn [_token]
           (st/emit! (dwtl/delete-token-matrix-row
                      (:definitions @context-row*)))))

        add-token
        (mf/use-fn
         (mf/deps selected-token-set-id tokens-lib variants)
         (fn [_event type]
           (let [variant-set-ids (->> variants
                                      (keep :write-set-id)
                                      distinct
                                      vec)
                 set-id (or (first variant-set-ids)
                            selected-token-set-id
                            (some-> tokens-lib ctob/get-sets first ctob/get-id))
                 {:keys [title modal]} (get dwta/token-properties type)
                 {:keys [key fields]} modal]
             (reset! add-menu* nil)
             (st/emit!
              (modal/show key {:position :center
                               :owner-bounds (let [rect (.getBoundingClientRect (mf/ref-val panel-ref))]
                                               {:top (.-top rect) :left (.-left rect)
                                                :right (- js/window.innerWidth (.-right rect))
                                                :bottom (- js/window.innerHeight (.-bottom rect))})
                               :selected-token-set-id set-id
                               :fields fields
                               :title title
                               :action "create"
                               :token-type type
                               :on-create-token
                               (when (seq variant-set-ids)
                                 (fn [token undo-group]
                                   (dwtl/create-token-in-sets
                                    variant-set-ids
                                    token
                                    :undo-group undo-group)))})))))]

    (mf/with-effect [axes can-edit?]
      (when can-edit?
        (doseq [{:keys [name variants]} axes
                :when (not-any? :active? variants)
                :let [variant (first variants)]
                :when variant]
          (st/emit! (dwtl/activate-token-matrix-variant
                     name
                     (:set-id variant))))))

    (mf/with-effect [can-edit?]
      (let [previous-can-edit? (mf/ref-val previous-can-edit-ref)]
        (mf/set-ref-val! previous-can-edit-ref can-edit?)
        (when (and previous-can-edit? (not can-edit?))
          (reset! axis-menu* nil)
          (reset! variant-menu* nil)
          (reset! add-menu* nil)
          (reset! combination-open* false)
          (reset! contract-open* false)
          (reset! context-row* nil)
          (reset! rename-target* nil)
          (reset! inline-edit* nil)
          (st/emit! (dwtl/assign-token-context-menu nil)
                    (modal/hide)))))

    [:section {:ref panel-ref
               :class (stl/css-case :matrix-panel true
                                    :matrix-panel-expanded expanded?)
               :data-testid "smallpen-token-matrix"
               :data-expanded (str expanded?)
               :on-context-menu dom/prevent-default-context-menu}
     [:header {:class (stl/css :axis-bar)}
      [:nav {:class (stl/css :axis-tabs)
             :on-scroll #(reset! axis-menu* nil)
             :aria-label (tr "workspace.tokens.matrix.axes")}
       (for [{:keys [id name] :as axis} axes]
         [:div {:key (str id)
                :class (stl/css :axis-tab-wrapper)
                :on-context-menu (when can-edit?
                                   (fn [event]
                                     (dom/prevent-default event)
                                     (reset! active-axis-id* id)
                                     (toggle-axis-menu event id)))}
          [:button {:type "button"
                    :class (stl/css-case :axis-tab true
                                         :axis-tab-active (= (:id active-axis) id))
                    :on-click #(reset! active-axis-id* id)}
           [:span name]
           (when can-edit?
             [:span {:class (stl/css :hover-chevron)
                     :on-click (fn [event]
                                 (toggle-axis-menu event id))}
              [:> icon* {:icon-id i/arrow-down :size "s"}]])]
          (when (and can-edit? (= @axis-menu* id))
            (mf/portal
             (mf/html
              [:div {:class (stl/css :add-variable-popover)
                     :style #js {:left (str (:left @axis-menu-position*) "px")
                                 :top (str (:top @axis-menu-position*) "px")}}
               [:> dropdown-menu* {:show true
                                   :id (str "token-axis-menu-" id)
                                   :class (stl/css :matrix-menu :axis-menu)
                                   :on-close #(reset! axis-menu* nil)}
                [:> dropdown-menu-item* {:class (stl/css :matrix-menu-item)
                                         :on-click #(open-rename % :axis axis)}
                 (tr "labels.rename")]
                [:> dropdown-menu-item* {:class (stl/css :matrix-menu-item :danger-menu-item)
                                         :on-click #(confirm-delete-axis axis)}
                 (tr "labels.delete")]]])
             popup-container))])
       (when can-edit?
         [:> icon-button* {:icon i/add
                           :variant "ghost"
                           :aria-label (tr "workspace.tokens.matrix.add-axis")
                           :on-click open-add-axis}])]
      [:div {:class (stl/css :panel-actions)}
       (when (and can-edit? active-axis)
         [:> button* {:variant "primary"
                      :icon i/add
                      :class (stl/css :add-variable-button)
                      :aria-expanded (some? @add-menu*)
                      :aria-haspopup "menu"
                      :on-click toggle-add-menu}
          (tr "workspace.tokens.matrix.add-variable")])
       (when (and can-edit? (smallpen/enabled?))
         [:> icon-button* {:icon i/import-export
                           :variant "ghost"
                           :aria-label (tr "smallpen.tokens.import.title")
                           :data-testid "smallpen-import-tokens-button"
                           :on-click #(modal/show! :smallpen/import-tokens {})}])
       (when (and can-edit? (seq axes))
         [:> icon-button* {:icon i/settings
                           :variant "ghost"
                           :aria-label (tr "workspace.tokens.matrix.current-combination")
                           :on-click #(reset! combination-open* true)}])
       (when show-expand-action
         [:> icon-button* {:icon i/expand
                           :variant "ghost"
                           :aria-label (if expanded?
                                         (tr "labels.collapse")
                                         (tr "workspace.sidebar.expand"))
                           :on-click #(swap! expanded* not)}])
       [:> icon-button* {:icon i/close
                         :variant "ghost"
                         :aria-label (tr "labels.close")
                         :on-click close-panel}]]]

     [:div {:class (stl/css :matrix-scroll)}
      [:div {:class (stl/css :matrix-content)}
       [:div {:class (stl/css :variant-header)
              :style (grid-style (count variants))}
        [:div {:class (stl/css :name-header)}
         [:span (tr "workspace.tokens.matrix.name")]
         [:button {:type "button"
                   :class (stl/css :contract-button)
                   :title (tr "workspace.tokens.matrix.global-contract")
                   :on-click (when can-edit? open-contracts)
                   :disabled (not can-edit?)}
          [:> icon* {:icon-id i/lock :size "s"}]]]
        (for [{:keys [id name active?] :as variant} variants]
          [:div {:key (str id)
                 :class (stl/css-case :variant-heading true
                                      :variant-heading-active active?)
                 :on-context-menu (when can-edit?
                                    (fn [event]
                                      (dom/prevent-default event)
                                      (reset! variant-menu* id)))}
           [:button {:type "button"
                     :class (stl/css-case :variant-active-button true
                                          :variant-active-button-selected active?)
                     :aria-label (tr "workspace.tokens.matrix.activate-variant" name)
                     :aria-pressed active?
                     :disabled (not can-edit?)
                     :on-click #(when can-edit?
                                  (st/emit!
                                   (dwtl/activate-token-matrix-variant
                                    (:name active-axis)
                                    (:set-id variant))))}
            [:span]]
           [:span {:class (stl/css :variant-name)} name]
           (when can-edit?
             [:button {:type "button"
                       :class (stl/css :variant-menu-button)
                       :aria-label (tr "workspace.tokens.matrix.variant-menu" name)
                       :on-click (fn [event]
                                   (dom/stop-propagation event)
                                   (reset! variant-menu* (when-not (= @variant-menu* id) id)))}
              [:> icon* {:icon-id i/arrow-down :size "s"}]])
           (when can-edit?
             [:> dropdown-menu* {:show (= @variant-menu* id)
                                 :id (str "token-variant-menu-" id)
                                 :class (stl/css :matrix-menu :variant-menu)
                                 :on-close #(reset! variant-menu* nil)}
              [:> dropdown-menu-item* {:class (stl/css :matrix-menu-item)
                                       :on-click #(open-rename % :variant variant)}
               (tr "labels.rename")]
              [:> dropdown-menu-item* {:class (stl/css :matrix-menu-item :danger-menu-item)
                                       :on-click #(confirm-delete-variant variant)}
               (tr "labels.delete")]])])
        (when can-edit?
          [:> icon-button* {:icon i/add
                            :variant "ghost"
                            :aria-label (tr "workspace.tokens.matrix.add-variant")
                            :on-click add-variant}])]

       (if (seq rows)
         [:div {:class (stl/css :token-rows)}
          (for [{:keys [name type cells] :as row} rows]
            [:div {:key name
                   :class (stl/css :token-row)
                   :style (grid-style (count variants))
                   :on-context-menu (when can-edit?
                                      #(open-token-menu % row))}
             [:div {:class (stl/css :token-name-cell)}
              [:span {:class (stl/css :type-icon)
                      :title (get-in dwta/token-properties [type :title])}
               [:> icon* {:icon-id (group/token-section-icon type) :size "s"}]]
              [:span {:class (stl/css :token-name)} name]
              (when can-edit?
                [:button {:type "button"
                          :class (stl/css :token-rename-button)
                          :aria-label (tr "workspace.tokens.matrix.rename-token-menu" name)
                          :title (tr "workspace.tokens.matrix.rename-token-menu" name)
                          :on-click #(open-token-rename % row)}
                 [:> pencil-icon*]])]
             (for [[index cell] (map-indexed vector cells)]
               [:div {:key (str name "-" index)
                      :class (stl/css-case :token-value-wrapper true
                                           :token-value-wrapper-active
                                           (:active? (nth variants index)))}
                [:> token-value-cell* {:cell (assoc cell
                                                    :matrix-cell-id
                                                    [(:id active-axis) index name])
                                       :can-edit? can-edit?
                                       :edit @inline-edit*
                                       :expanded expanded?
                                       :reference-options
                                       (matrix-data/reference-options tokens-lib
                                                                      (cell-token cell)
                                                                      (:variant cell))
                                       :resolved-tokens
                                       (get resolved-tokens-by-variant
                                            (-> cell :variant :id))
                                       :on-start-edit start-inline-edit
                                       :on-change-value change-inline-value
                                       :on-save-value save-inline-raw-value
                                       :on-save-choice save-choice-value
                                       :on-open-color open-inline-color
                                       :on-cancel cancel-inline-edit}]])
             [:div {:class (stl/css :row-actions)}
              (when (and can-edit? (some :token cells))
                [:> icon-button* {:icon i/menu
                                  :variant "ghost"
                                  :aria-label (tr "workspace.tokens.matrix.token-menu" name)
                                  :on-click #(open-token-menu % row)}])]])]
         [:div {:class (stl/css :empty-matrix)}
          [:span (tr "workspace.tokens.matrix.empty")]
          (when (and can-edit? active-axis)
            [:> button* {:variant "secondary"
                         :icon i/add
                         :aria-expanded (some? @add-menu*)
                         :aria-haspopup "menu"
                         :on-click toggle-add-menu}
             (tr "workspace.tokens.matrix.add-variable")])])]]

     (when (and can-edit? @add-menu*)
       (mf/portal
        (mf/html
         [:div {:class (stl/css :add-variable-popover)
                :style #js {:left (str (:left @add-menu*) "px")
                            :top (str (:top @add-menu*) "px")}}
          [:> dropdown-menu* {:show true
                              :id "token-matrix-add-variable"
                              :class (stl/css :matrix-menu :add-variable-menu)
                              :on-close #(reset! add-menu* nil)}
           (for [type addable-token-types]
             (let [{:keys [title]} (get dwta/token-properties type)]
               [:> dropdown-menu-item* {:key (name type)
                                        :class (stl/css :matrix-menu-item :type-menu-item)
                                        :on-click #(add-token % type)}
                [:> icon* {:icon-id (group/token-section-icon type) :size "s"}]
                [:span title]]))]])
        popup-container))

     (when can-edit?
       [:& token-context-menu {:on-delete-token delete-context-token}])
     [:> combination-dialog* {:axes axes
                              :show (and can-edit? @combination-open*)
                              :on-change (when can-edit? change-combination)
                              :on-close #(reset! combination-open* false)}]
     (when (and can-edit? @rename-target*)
       (mf/portal
        (mf/html
         [:> rename-popover* {:target @rename-target*
                              :position (:position @rename-target*)
                              :value @rename-value*
                              :description @rename-description*
                              :error @rename-error*
                              :on-change #(reset! rename-value* (dom/get-target-val %))
                              :on-description-change #(reset! rename-description*
                                                              (dom/get-target-val %))
                              :on-close close-rename
                              :on-save save-rename}])
        popup-container))
     [:> contract-drawer* {:show (and can-edit? @contract-open*)
                           :types addable-token-types
                           :drafts @contract-drafts*
                           :on-change (when can-edit? change-contract)
                           :on-close #(reset! contract-open* false)}]]))
