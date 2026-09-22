;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.colorpicker.color-inputs
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.math :as mth]
   [app.common.types.color :as cc]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.controls.shared.options-dropdown :refer [options-dropdown*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.hooks :as hooks]
   [app.main.ui.workspace.colorpicker.color-inputs-data :as input-data]
   [app.main.ui.workspace.tokens.management.forms.controls.floating-dropdown :refer [use-floating-dropdown]]
   [app.main.ui.workspace.tokens.management.forms.controls.token-parsing :as token-parsing]
   [app.main.ui.workspace.tokens.management.forms.controls.utils :as controls-utils]
   [app.util.dom :as dom]
   [app.util.keyboard :as kbd]
   [rumext.v2 :as mf]))

(defn parse-hex
  [val]
  (if (= (first val) \#)
    val
    (str \# val)))

(defn value->hsv-value
  [val]
  (* 255 (/ val 100)))

(defn hsv-value->value
  [val]
  (* (/ val 255) 100))

(mf/defc reference-hex-input*
  {::mf/private true}
  [{:keys [hex reference-name reference-tokens on-change-color
           on-change-reference on-clear-reference]}]
  (let [input-ref        (mf/use-ref nil)
        input-wrapper-ref (mf/use-ref nil)
        wrapper-ref      (mf/use-ref nil)
        dropdown-ref     (mf/use-ref nil)
        listbox-id       (mf/use-id)
        container        (hooks/use-portal-container)
        reference-tokens (vec (or reference-tokens []))
        editing?*        (mf/use-state false)
        editing?         (deref editing?*)
        draft*           (mf/use-state #(input-data/display-value hex reference-name))
        draft            (deref draft*)
        open?*           (mf/use-state false)
        open?            (deref open?*)
        filter-term*     (mf/use-state "")
        filter-term      (deref filter-term*)
        focused-index*   (mf/use-state nil)
        dropdown-options (mf/with-memo [reference-tokens filter-term]
                           @(controls-utils/get-token-dropdown-options
                             {:color reference-tokens}
                             (str "{" filter-term)))
        focusable-options (vec (controls-utils/focusable-options dropdown-options))
        focused-id       (some->> @focused-index*
                                  (get focusable-options)
                                  :id)
        selected-id      (some->> reference-tokens
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
         (mf/deps reference-name on-change-reference)
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
         (mf/deps draft reference-tokens on-change-color on-clear-reference)
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
         (mf/deps open?)
         (fn [_]
           (when-not open?
             (commit-value)
             (reset! editing?* false))))

        update-reference-options
        (mf/use-fn
         (fn [value node]
           (if-let [active-reference (token-parsing/active-token value node)]
             (do
               (reset! open?* true)
               (reset! filter-term* (:partial active-reference))
               (reset! focused-index* nil))
             (close-options))))

        on-change
        (mf/use-fn
         (mf/deps on-change-color on-clear-reference)
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
         (mf/deps reference-tokens)
         (fn [event]
           (let [id    (dom/get-data (dom/get-current-target event) "id")
                 token (some #(when (= id (str (:id %))) %) reference-tokens)]
             (select-reference token))))

        on-key-down
        (mf/use-fn
         (mf/deps open? focusable-options)
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
                  (nth focusable-options (or @focused-index* 0))))

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

    (mf/with-effect [hex reference-name editing?]
      (when-not editing?
        (reset! draft* (input-data/display-value hex reference-name))))

    (mf/with-effect [open?]
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
                    (commit-value)
                    (close-options)
                    (reset! editing?* false))))]
          (.addEventListener js/document "mousedown" handler)
          #(.removeEventListener js/document "mousedown" handler))))

    [:div {:class (stl/css :hex-input :reference-hex-input)
           :ref wrapper-ref}
     [:> input* {:id "hex-value"
                 :ref input-ref
                 :input-wrapper-ref input-wrapper-ref
                 :type "text"
                 :text-icon "HEX"
                 :property "Hex"
                 :aria-label "Hexadecimal color value or token reference"
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

(mf/defc color-inputs*
  [{:keys [type color disable-opacity mode on-mode-change on-change
           reference-name reference-tokens on-change-reference on-clear-reference]}]
  (let [{red :r green :g blue :b
         hue :h saturation :s value :v
         hex :hex alpha :alpha} color

        ;; Sub-model selector for the HSB tab: users can toggle between
        ;; HSB and HSL input display without leaving the tab. State is
        ;; lifted to the colorpicker parent so the slider labels stay
        ;; in sync with the inputs.
        hsb-mode  (or mode :hsb)

        ;; Compute HSL from current RGB (derived; not stored on the color map)
        [_hsl-h hsl-s hsl-l]
        (if (and red green blue)
          (cc/rgb->hsl [red green blue])
          [0 0 0])

        refs {:r     (mf/use-ref nil)
              :g     (mf/use-ref nil)
              :b     (mf/use-ref nil)
              :h     (mf/use-ref nil)
              :s     (mf/use-ref nil)
              :v     (mf/use-ref nil)
              :hsl-s (mf/use-ref nil)
              :hsl-l (mf/use-ref nil)
              :alpha (mf/use-ref nil)}

        setup-hex-color
        (fn [hex]
          (let [[r g b] (cc/hex->rgb hex)
                [h s v] (cc/hex->hsv hex)]
            (on-change {:hex hex
                        :h h :s s :v v
                        :r r :g g :b b})))
        apply-property-change
        (fn [property val]
          (let [val (case property
                      :s (/ val 100)
                      :v (value->hsv-value val)
                      (:hsl-s :hsl-l) (/ val 100)
                      :alpha (/ val 100)
                      val)]
            (cond
              (= property :alpha)
              (on-change {:alpha val})

              (#{:r :g :b} property)
              (let [{:keys [r g b]} (merge color (hash-map property val))
                    hex (cc/rgb->hex [r g b])
                    [h s v] (cc/hex->hsv hex)]
                (on-change {:hex hex
                            :h h :s s :v v
                            :r r :g g :b b}))

              ;; HSL changes: recompute RGB/HSV from the new HSL triple,
              ;; reusing the current hue when only S or L changes.
              (#{:hsl-s :hsl-l} property)
              (let [new-s   (if (= property :hsl-s) val hsl-s)
                    new-l   (if (= property :hsl-l) val hsl-l)
                    [r g b] (cc/hsl->rgb [hue new-s new-l])
                    hex     (cc/rgb->hex [r g b])
                    [h s v] (cc/hex->hsv hex)]
                (on-change {:hex hex
                            :h h :s s :v v
                            :r r :g g :b b}))

              :else
              (let [{:keys [h s v]} (merge color (hash-map property val))
                    hex (cc/hsv->hex [h s v])
                    [r g b] (cc/hex->rgb hex)]
                (on-change {:hex hex
                            :h h :s s :v v
                            :r r :g g :b b})))))

        on-change-property
        (fn [property max-value]
          (fn [e]
            (let [val (-> e dom/get-target-val d/parse-double (mth/clamp 0 max-value))]
              (when (some? val)
                (apply-property-change property val)))))

        on-key-down-step
        (fn [max-value on-step]
          (fn [e]
            (let [up?   (kbd/up-arrow? e)
                  down? (kbd/down-arrow? e)]
              (when (and (or up? down?)
                         (or (kbd/shift? e) (kbd/alt? e)))
                (dom/prevent-default e)
                (when-let [current-value (-> e dom/get-target-val d/parse-double)]
                  (let [step      (cond
                                    (kbd/shift? e) (if up? 10 -10)
                                    (kbd/alt? e)   (if up? 0.1 -0.1))
                        new-value (mth/clamp (+ current-value step) 0 max-value)
                        node      (dom/get-target e)]
                    (dom/set-value! node new-value)
                    (on-step new-value)))))))

        on-key-down-property
        (fn [property max-value]
          (on-key-down-step max-value #(apply-property-change property %)))]


    ;; Updates the inputs values when a property is changed in the parent
    (mf/use-effect
     (mf/deps color type hsb-mode)
     (fn []
       (doseq [ref-key (keys refs)]
         (let [property-val (case ref-key
                              :hsl-s hsl-s
                              :hsl-l hsl-l
                              (get color ref-key))
               property-ref (get refs ref-key)]
           (when (and property-val property-ref)
             (when-let [node (mf/ref-val property-ref)]
               (let [new-val
                     (case ref-key
                       (:s :alpha) (mth/precision (* property-val 100) 2)
                       :v   (mth/precision (hsv-value->value property-val) 2)
                       (:hsl-s :hsl-l) (mth/precision (* property-val 100) 2)
                       property-val)]
                 (dom/set-value! node new-val))))))))

    [:div {:class (stl/css-case :color-values true
                                :disable-opacity disable-opacity)}

     ;; Inline HSB/HSL switcher — only shown on the HSB tab so that
     ;; designers can pick whichever hue-based model matches their
     ;; workflow (HSB matches Figma/Sketch/XD, HSL matches CSS).
     (when (and (not= type :rgb) on-mode-change)
       [:div {:class (stl/css :model-switcher)}
        [:button {:type "button"
                  :class (stl/css-case :model-pill true
                                       :model-pill-active (= hsb-mode :hsb))
                  :on-click #(on-mode-change :hsb)}
         "HSB"]
        [:button {:type "button"
                  :class (stl/css-case :model-pill true
                                       :model-pill-active (= hsb-mode :hsl))
                  :on-click #(on-mode-change :hsl)}
         "HSL"]])

     [:div {:class (stl/css :colors-row)}
      (cond
        (= type :rgb)
        [:*
         [:> input* {:id "red-value"
                     :ref (:r refs)
                     :type "number"
                     :min 0
                     :icon i/character-r
                     :property "Red"
                     :aria-label "Red"
                     :max 255
                     :default-value red
                     :on-change (on-change-property :r 255)
                     :on-key-down (on-key-down-property :r 255)}]
         [:> input* {:id "green-value"
                     :ref (:g refs)
                     :type "number"
                     :min 0
                     :icon i/character-g
                     :property "Green"
                     :aria-label "Green"
                     :max 255
                     :default-value green
                     :on-change (on-change-property :g 255)
                     :on-key-down (on-key-down-property :g 255)}]
         [:> input* {:id "blue-value"
                     :ref (:b refs)
                     :type "number"
                     :min 0
                     :icon i/character-b
                     :property "Blue"
                     :aria-label "Blue"
                     :max 255
                     :default-value blue
                     :on-change (on-change-property :b 255)
                     :on-key-down (on-key-down-property :b 255)}]]

        (= hsb-mode :hsl)
        [:*
         [:> input* {:id "hue-value"
                     :ref (:h refs)
                     :type "number"
                     :min 0
                     :icon i/character-h
                     :property "Hue"
                     :aria-label "Hue"
                     :max 360
                     :default-value hue
                     :on-change (on-change-property :h 360)
                     :on-key-down (on-key-down-property :h 360)}]
         [:> input* {:id "saturation-value"
                     :ref (:s refs)
                     :type "number"
                     :min 0
                     :icon i/character-s
                     :property "Saturation"
                     :aria-label "Saturation"
                     :max 100
                     :step 1
                     :default-value saturation
                     :on-change (on-change-property :s 100)
                     :on-key-down (on-key-down-property :s 100)}]
         [:> input* {:id "lightness-value"
                     :ref (:hsl-l refs)
                     :type "number"
                     :min 0
                     :icon i/character-l
                     :property "Lightness"
                     :aria-label "Lightness"
                     :max 100
                     :step 1
                     :default-value (mth/precision (* hsl-l 100) 2)
                     :on-change (on-change-property :hsl-l 100)
                     :on-key-down (on-key-down-property :hsl-l 100)}]]
        :else
        [:*
         [:> input* {:id "hue-value"
                     :ref (:h refs)
                     :type "number"
                     :min 0
                     :icon i/character-h
                     :property "Hue"
                     :aria-label "Hue"
                     :max 360
                     :default-value hue
                     :on-change (on-change-property :h 360)
                     :on-key-down (on-key-down-property :h 360)}]
         [:> input* {:id "saturation-value"
                     :ref (:s refs)
                     :type "number"
                     :min 0
                     :icon i/character-s
                     :property "Saturation"
                     :max 100
                     :step 1
                     :aria-label "Saturation"
                     :default-value saturation
                     :on-change (on-change-property :s 100)
                     :on-key-down (on-key-down-property :s 100)}]

         [:> input* {:id "brightness-value"
                     :ref (:v refs)
                     :type "number"
                     :min 0
                     :text-icon "B(V)"
                     :property "Brightness"
                     :aria-label "Brightness (Value)"
                     :max 100
                     :step 1
                     :default-value value
                     :on-change (on-change-property :v 100)
                     :on-key-down (on-key-down-property :v 100)}]])]
     [:div {:class (stl/css :hex-alpha-wrapper)}
      [:> reference-hex-input* {:hex hex
                                :reference-name reference-name
                                :reference-tokens reference-tokens
                                :on-change-color setup-hex-color
                                :on-change-reference on-change-reference
                                :on-clear-reference on-clear-reference}]

      (when (not disable-opacity)
        [:> input* {:id "alpha-value"
                    :ref (:alpha refs)
                    :type "number"
                    :class (stl/css :alpha-input)
                    :min 0
                    :icon i/character-a
                    :property "Alpha"
                    :max 100
                    :step 1
                    :aria-label "Alpha"
                    :default-value (if (= alpha :multiple) "" (mth/precision (* alpha 100) 2))
                    :on-change (on-change-property :alpha 100)
                    :on-key-down (on-key-down-property :alpha 100)}])]]))
