;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.reference-hex-input
  "SmallPen colorpicker hex field that also accepts a `{token}` reference.
  Upstream Penpot keeps its plain hex input; this field replaces it only in
  the SmallPen profile."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.types.color :as cc]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.controls.shared.options-dropdown :refer [options-dropdown*]]
   [app.main.ui.hooks :as hooks]
   [app.main.ui.workspace.colorpicker.color-inputs-data :as input-data]
   [app.main.ui.workspace.tokens.management.forms.controls.floating-dropdown :refer [use-floating-dropdown]]
   [app.main.ui.workspace.tokens.management.forms.controls.token-parsing :as token-parsing]
   [app.main.ui.workspace.tokens.management.forms.controls.utils :as controls-utils]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn- parse-hex
  [val]
  (if (= (first val) \#)
    val
    (str \# val)))

(mf/defc reference-hex-input*
  [{:keys [hex reference-name reference-tokens on-change-color
           on-change-reference on-clear-reference]}]
  (let [input-ref         (mf/use-ref nil)
        input-wrapper-ref (mf/use-ref nil)
        wrapper-ref       (mf/use-ref nil)
        dropdown-ref      (mf/use-ref nil)
        listbox-id        (mf/use-id)
        container         (hooks/use-portal-container)
        reference-tokens  (mf/with-memo [reference-tokens]
                            (vec (or reference-tokens [])))
        editing?*         (mf/use-state false)
        editing?          (deref editing?*)
        draft*            (mf/use-state #(input-data/display-value hex reference-name))
        draft             (deref draft*)
        open?*            (mf/use-state false)
        open?             (deref open?*)
        filter-term*      (mf/use-state "")
        filter-term       (deref filter-term*)
        focused-index*    (mf/use-state nil)
        focused-index     (deref focused-index*)
        dropdown-options  (mf/with-memo [reference-tokens filter-term]
                            (input-data/color-dropdown-options
                             @(controls-utils/get-token-dropdown-options
                               {:color reference-tokens}
                               (str "{" filter-term))))
        focusable-options (mf/with-memo [dropdown-options]
                            (vec (controls-utils/focusable-options dropdown-options)))
        focused-id        (some->> focused-index
                                   (get focusable-options)
                                   :id)
        selected-id       (some->> reference-tokens
                                   (some #(when (= reference-name (:name %)) %))
                                   :id
                                   str)

        close-options
        (mf/use-fn
         (fn []
           (reset! open?* false)
           (reset! filter-term* "")
           (reset! focused-index* nil)))

        restore-display
        (mf/use-fn
         (mf/deps hex reference-name)
         (fn []
           (reset! draft* (input-data/display-value hex reference-name))))

        select-reference
        (mf/use-fn
         (mf/deps reference-name reference-tokens on-change-reference close-options)
         (fn [token]
           (when token
             (let [token (or (some #(when (= (:name token) (:name %)) %)
                                   reference-tokens)
                             token)
                   value (input-data/reference-value (:name token))]
               (reset! draft* value)
               (close-options)
               (when (not= reference-name (:name token))
                 (on-change-reference token))
               (js/requestAnimationFrame
                (fn []
                  (when-let [node (mf/ref-val input-ref)]
                    (dom/focus! node)
                    (let [cursor (count value)]
                      (dom/set-selection-range! node cursor cursor)))))))))

        commit-value
        (mf/use-fn
         (mf/deps draft reference-tokens on-change-color on-clear-reference
                  select-reference restore-display)
         (fn []
           (if-let [token (input-data/find-reference-token reference-tokens draft)]
             (select-reference token)
             (let [value (cond
                           (cc/color-string? draft) (cc/parse draft)
                           (cc/valid-hex-color? (parse-hex draft)) (parse-hex draft))]
               (if value
                 (do
                   (on-clear-reference)
                   (on-change-color value))
                 (restore-display))))))

        ;; The document listener below outlives renders, so it reads the
        ;; latest commit through a ref instead of a stale closure.
        commit-value-ref
        (mf/use-ref commit-value)

        on-focus
        (mf/use-fn
         (mf/deps hex reference-name)
         (fn [_]
           (reset! editing?* true)
           (reset! draft* (or (input-data/reference-value reference-name) hex))
           (js/requestAnimationFrame
            (fn []
              (when-let [node (mf/ref-val input-ref)]
                (dom/select-text! node))))))

        on-blur
        (mf/use-fn
         (mf/deps open? commit-value)
         (fn [_]
           (when-not open?
             (commit-value)
             (reset! editing?* false))))

        update-reference-options
        (mf/use-fn
         (mf/deps close-options)
         (fn [value node]
           (if-let [active-reference (token-parsing/active-token value node)]
             (do
               (reset! open?* true)
               (reset! filter-term* (:partial active-reference))
               (reset! focused-index* nil))
             (close-options))))

        on-change
        (mf/use-fn
         (mf/deps on-change-color on-clear-reference update-reference-options)
         (fn [event]
           (let [node  (dom/get-current-target event)
                 value (dom/get-target-val event)
                 color (parse-hex value)]
             (reset! draft* value)
             (update-reference-options value node)
             (when (cc/valid-hex-color? color)
               (on-clear-reference)
               (on-change-color color)))))

        on-option-click
        (mf/use-fn
         (mf/deps reference-tokens select-reference)
         (fn [event]
           (let [id    (dom/get-data (dom/get-current-target event) "id")
                 token (some #(when (= id (str (:id %))) %) reference-tokens)]
             (select-reference token))))

        on-key-down
        (mf/use-fn
         (mf/deps open? focusable-options focused-index select-reference
                  commit-value close-options restore-display)
         (fn [event]
           (let [key          (.-key event)
                 option-count (count focusable-options)]
             (cond
               (and open? (= key "ArrowDown") (pos? option-count))
               (do
                 (dom/prevent-default event)
                 (swap! focused-index* #(mod (inc (or % -1)) option-count)))

               (and open? (= key "ArrowUp") (pos? option-count))
               (do
                 (dom/prevent-default event)
                 (swap! focused-index* #(mod (dec (or % 0)) option-count)))

               (and open?
                    (or (= key "Enter") (= key "Tab"))
                    (pos? option-count))
               (do
                 (dom/prevent-default event)
                 (dom/stop-propagation event)
                 (select-reference
                  (nth focusable-options (or focused-index 0))))

               (= key "Enter")
               (do
                 (dom/prevent-default event)
                 (commit-value)
                 (close-options)
                 (reset! editing?* false)
                 (dom/blur! (dom/get-current-target event)))

               (= key "Escape")
               (do
                 (dom/prevent-default event)
                 (dom/stop-propagation event)
                 (close-options)
                 (restore-display)
                 (reset! editing?* false)
                 (dom/blur! (dom/get-current-target event)))

               (= key "Tab")
               (do
                 (commit-value)
                 (close-options)
                 (reset! editing?* false))

               :else nil))))

        {:keys [style ready?]}
        (use-floating-dropdown open? input-wrapper-ref wrapper-ref dropdown-ref)]

    (mf/with-effect [commit-value]
      (mf/set-ref-val! commit-value-ref commit-value))

    (mf/with-effect [hex reference-name editing?]
      (when-not editing?
        (reset! draft* (input-data/display-value hex reference-name))))

    (mf/with-effect [open? close-options]
      (when open?
        (let [handler
              (fn [event]
                (let [wrapper-node  (mf/ref-val wrapper-ref)
                      dropdown-node (mf/ref-val dropdown-ref)
                      target        (dom/get-target event)]
                  (when (and wrapper-node
                             (not (dom/child? target wrapper-node))
                             (or (nil? dropdown-node)
                                 (not (dom/child? target dropdown-node))))
                    ((mf/ref-val commit-value-ref))
                    (close-options)
                    (reset! editing?* false))))]
          (.addEventListener js/document "mousedown" handler)
          #(.removeEventListener js/document "mousedown" handler))))

    [:div {:class (stl/css :reference-hex-input)
           :ref wrapper-ref}
     [:> input* {:id "hex-value"
                 :ref input-ref
                 :input-wrapper-ref input-wrapper-ref
                 :type "text"
                 :text-icon "HEX"
                 :property "Hex"
                 :aria-label (tr "workspace.colorpicker.hex-or-token-reference")
                 :aria-autocomplete "list"
                 :aria-controls listbox-id
                 :aria-expanded open?
                 :aria-activedescendant focused-id
                 :max-length 256
                 :value draft
                 :on-focus on-focus
                 :on-change on-change
                 :on-blur on-blur
                 :on-key-down on-key-down}]
     (when open?
       (mf/portal
        (mf/html
         [:> options-dropdown* {:on-click on-option-click
                                :class (stl/css :reference-dropdown)
                                :style {:visibility (if ready? "visible" "hidden")
                                        :left (when-let [left (:left style)]
                                                (str "clamp(var(--sp-m), " left
                                                     ", calc(100vw - var(--reference-dropdown-width) - var(--sp-m)))"))
                                        :top (or (:top style) "unset")
                                        :bottom (or (:bottom style) "unset")}
                                :id listbox-id
                                :options dropdown-options
                                :focused focused-id
                                :selected selected-id
                                :align :right
                                :wrapper-ref dropdown-ref}])
        container))]))
