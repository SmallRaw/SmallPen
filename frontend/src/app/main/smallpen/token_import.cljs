;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.token-import
  "Review-then-apply import of a DTCG token file into the local Package.

  The Background does the parsing, diffing, and writing; this modal only
  shows the diff with real values and collects which rows to apply."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.modal :as modal]
   [app.main.smallpen :as smallpen]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

(defn- row-key
  [{:keys [set name]}]
  (str set "/" name))

(defn- diff-rows
  [diff]
  (concat
   (map #(assoc % :kind :added) (get-in diff [:tokens :added]))
   (map #(assoc % :kind :changed) (get-in diff [:tokens :changed]))
   (map #(assoc % :kind :removed) (get-in diff [:tokens :removed]))))

(defn- value-text
  [value]
  (cond
    (nil? value) ""
    (string? value) value
    (or (number? value) (boolean? value)) (str value)
    :else (js/JSON.stringify (clj->js value))))

(defn- hex-color?
  [type value]
  (and (= type "color") (string? value) (str/starts-with? value "#")))

(defn- kind-label
  [kind]
  (case kind
    :added (tr "smallpen.tokens.import.added")
    :changed (tr "smallpen.tokens.import.changed")
    :removed (tr "smallpen.tokens.import.removed")
    ""))

(defn- sets-and-themes-summary
  [diff]
  (let [sets   (:sets diff)
        themes (:themes diff)
        parts  (concat
                (map #(str "+" %) (:added sets))
                (map #(str "−" %) (:removed sets))
                (map #(str "+" (:path %)) (:added themes))
                (map #(str "~" (:path %)) (:changed themes))
                (map #(str "−" (:path %)) (:removed themes)))]
    (when (seq parts)
      (str/join ", " parts))))

(mf/defc value-cell*
  {::mf/private true
   ::mf/props :obj}
  [{:keys [type value description]}]
  [:span {:class (stl/css :value-stack)}
   [:span {:class (stl/css :value)}
    (when (hex-color? type value)
      [:span {:class (stl/css :swatch)
              :style #js {:background value}}])
    [:code {:class (stl/css :code)} (value-text value)]]
   (when-not (str/blank? description)
     [:span {:class (stl/css :description)} description])])

(defn- field-label
  [field]
  (case field
    "value" (tr "smallpen.tokens.import.field-value")
    "description" (tr "smallpen.tokens.import.field-description")
    "type" (tr "smallpen.tokens.import.field-type")
    field))

(mf/defc diff-row*
  {::mf/private true
   ::mf/props :obj}
  [{:keys [row selected on-toggle]}]
  (let [key      (row-key row)
        kind     (:kind row)
        current  (case kind
                   :changed (:before row)
                   :removed row
                   nil)
        incoming (case kind
                   :changed (:after row)
                   :added row
                   nil)
        toggle   (mf/use-fn (mf/deps key on-toggle) #(on-toggle key))]
    [:tr {:class (stl/css-case :row true
                               :added (= kind :added)
                               :changed (= kind :changed)
                               :removed (= kind :removed))}
     [:td {:class (stl/css :cell-check)}
      [:> checkbox* {:id (str "smallpen-import-" key)
                     :checked selected
                     :on-change toggle}]]
     [:td
      [:span {:class (stl/css :badge)} (kind-label kind)]
      [:code {:class (stl/css :code)} (:name row)]
      (when (= kind :changed)
        [:span {:class (stl/css :fields)}
         (str/join " · " (map field-label (:fields row)))])]
     [:td {:class (stl/css :cell-muted)} (:set row)]
     [:td (when current
            [:> value-cell* {:type (:type current)
                             :value (:value current)
                             :description (:description current)}])]
     [:td (when incoming
            [:> value-cell* {:type (:type incoming)
                             :value (:value incoming)
                             :description (:description incoming)}])]]))

(defn- file-set-name
  [file]
  (str/replace (.-name file) #"\.json$" ""))

(mf/defc import-tokens-modal*
  {::mf/register modal/components
   ::mf/register-as :smallpen/import-tokens}
  []
  (let [state     (mf/use-state {:document nil
                                 :error nil
                                 :file-name nil
                                 :result nil
                                 :selected #{}
                                 :set-name nil
                                 :stage :pick})
        {:keys [document error file-name result selected set-name stage]} @state
        input-ref (mf/use-ref nil)
        diff      (:diff result)
        rows      (vec (diff-rows diff))
        all-keys  (into #{} (map row-key) rows)
        summary   (:summary diff)
        warnings  (:warnings result)
        extras    (sets-and-themes-summary diff)

        choose-file
        (mf/use-fn
         (fn []
           (dom/click (mf/ref-val input-ref))))

        on-file
        (mf/use-fn
         (fn [event]
           (when-let [file (-> (dom/get-target event)
                               (dom/get-files)
                               (first))]
             (let [name (file-set-name file)]
               (swap! state assoc
                      :error nil
                      :file-name (.-name file)
                      :set-name name
                      :stage :loading)
               (-> (.text file)
                   (.then (fn [text] (js/JSON.parse text)))
                   (.then (fn [doc]
                            (-> (smallpen/import-tokens! {:document doc
                                                          :setName name})
                                (.then (fn [res]
                                         (swap! state assoc
                                                :document doc
                                                :result res
                                                :selected (into #{}
                                                                (map row-key)
                                                                (diff-rows (:diff res)))
                                                :stage :review))))))
                   (.catch (fn [cause]
                             (swap! state assoc
                                    :stage :pick
                                    :error (or (ex-message cause)
                                               (tr "smallpen.tokens.import.read-error"))))))))
           (dom/set-value! (mf/ref-val input-ref) "")))

        toggle
        (mf/use-fn
         (fn [key]
           (swap! state update :selected
                  #(if (contains? % key) (disj % key) (conj % key)))))

        select-all
        (mf/use-fn
         (mf/deps all-keys)
         (fn [] (swap! state assoc :selected all-keys)))

        select-none
        (mf/use-fn
         (fn [] (swap! state assoc :selected #{})))

        apply-import
        (mf/use-fn
         (mf/deps document selected set-name)
         (fn []
           (swap! state assoc :stage :applying :error nil)
           (-> (smallpen/import-tokens! {:apply true
                                         :document document
                                         :selection (vec selected)
                                         :setName set-name})
               (.then (fn [res]
                        (swap! state assoc :stage :done)
                        (smallpen/reload-after-external-write! (:revision res))))
               (.catch (fn [cause]
                         (swap! state assoc
                                :stage :review
                                :error (or (ex-message cause) (tr "errors.generic"))))))))]

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :data-testid "smallpen-import-tokens"}
      [:> icon-button* {:class (stl/css :close-btn)
                        :on-click modal/hide!
                        :aria-label (tr "labels.close")
                        :variant "ghost"
                        :icon i/close}]
      [:div {:class (stl/css :body)}
       [:> heading* {:level 2 :typography "headline-medium"}
        (tr "smallpen.tokens.import.title")]
       [:input {:type "file"
                :accept ".json,application/json"
                :ref input-ref
                :on-change on-file
                :class (stl/css :hidden-input)}]

       (case stage
         (:pick :loading)
         [:div {:class (stl/css :pick)}
          [:> text* {:as "p" :typography "body-medium"}
           (tr "smallpen.tokens.import.hint")]
          [:> button* {:type "button"
                       :on-click choose-file
                       :disabled (= stage :loading)}
           (tr "smallpen.tokens.import.choose-file")]
          (when error
            [:> text* {:as "p" :typography "body-small" :class (stl/css :error)}
             error])]

         (:review :applying :done)
         [:div {:class (stl/css :review)}
          [:> text* {:as "p" :typography "body-medium" :class (stl/css :file-name)}
           file-name]
          [:> text* {:as "p" :typography "body-medium" :class (stl/css :summary)}
           (tr "smallpen.tokens.import.summary"
               (:tokensAdded summary 0)
               (:tokensChanged summary 0)
               (:tokensRemoved summary 0)
               (count warnings))]
          (if (empty? rows)
            [:> text* {:as "p" :typography "body-medium"}
             (tr "smallpen.tokens.import.nothing")]
            [:*
             [:div {:class (stl/css :toolbar)}
              [:> button* {:variant "secondary" :type "button" :on-click select-all}
               (tr "smallpen.tokens.import.select-all")]
              [:> button* {:variant "secondary" :type "button" :on-click select-none}
               (tr "smallpen.tokens.import.select-none")]]
             [:div {:class (stl/css :table-wrap)}
              [:table {:class (stl/css :table)}
               [:thead
                [:tr
                 [:th ""]
                 [:th (tr "smallpen.tokens.import.name")]
                 [:th (tr "smallpen.tokens.import.set")]
                 [:th (tr "smallpen.tokens.import.current")]
                 [:th (tr "smallpen.tokens.import.incoming")]]]
               [:tbody
                (for [row rows]
                  [:> diff-row* {:key (row-key row)
                                 :row row
                                 :selected (contains? selected (row-key row))
                                 :on-toggle toggle}])]]]])
          (when extras
            [:> text* {:as "p" :typography "body-small" :class (stl/css :summary)}
             (tr "smallpen.tokens.import.sets-themes" extras)])
          (when (seq warnings)
            [:div
             [:> text* {:as "p" :typography "body-small" :class (stl/css :summary)}
              (tr "smallpen.tokens.import.skipped")]
             [:ul {:class (stl/css :warnings)}
              (for [{:keys [alias code name set]} warnings]
                [:li {:key (str set "/" name)}
                 [:code {:class (stl/css :code)} (str set "/" name)]
                 " — " code
                 (when alias (str " (" alias ")"))])]])
          (when error
            [:> text* {:as "p" :typography "body-small" :class (stl/css :error)}
             error])
          (when (= stage :done)
            [:> text* {:as "p" :typography "body-small"}
             (tr "smallpen.tokens.import.done")])
          [:div {:class (stl/css :footer)}
           [:> button* {:variant "secondary"
                        :type "button"
                        :on-click modal/hide!
                        :disabled (= stage :applying)}
            (tr "labels.cancel")]
           [:> button* {:type "button"
                        :on-click apply-import
                        :disabled (not= stage :review)}
            (if (= stage :applying)
              (tr "smallpen.tokens.import.applying")
              (tr "smallpen.tokens.import.apply"))]]]

         nil)]]]))
