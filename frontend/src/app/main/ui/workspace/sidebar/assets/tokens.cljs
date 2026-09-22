;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.sidebar.assets.tokens
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.files.tokens :as cfo]
   [app.main.data.workspace.tokens.application :as dwta]
   [app.main.data.workspace.tokens.color :as dwtc]
   [app.main.data.workspace.tokens.format :as dwtf]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.utilities.swatch :refer [swatch*]]
   [app.main.ui.workspace.sidebar.assets.common :as cmm]
   [app.main.ui.workspace.sidebar.assets.tokens-data :as tokens-data]
   [app.main.ui.workspace.tokens.management.group :as token-group]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn- displayed-token-value
  [token]
  (dwtf/format-token-value (tokens-data/effective-token-value token)))

(mf/defc token-item*
  {::mf/private true}
  [{:keys [token]}]
  (let [{:keys [name type value errors]} token
        reference? (cfo/is-reference? token)
        color       (when (cfo/color-token? token)
                      (or (dwtc/resolved-token-bullet-color token)
                          (dwtc/color-bullet-color value)))
        value-label (displayed-token-value token)
        reference-label (when reference?
                          (dwtf/format-token-value value))
        title       (cond-> (str name "\n" value-label)
                      reference? (str "\n" reference-label))]
    [:div {:class (stl/css-case :token-item true
                                :token-item-error (seq errors))
           :data-testid "smallpen-library-token"
           :title title}
     [:span {:class (stl/css :token-visual)}
      (cond
        (seq errors)
        [:> icon* {:icon-id i/broken-link :size "s"}]

        color
        [:> swatch* {:background color
                     :show-tooltip false
                     :size "small"}]

        :else
        [:> icon* {:icon-id (token-group/token-section-icon type)
                   :size "s"}])]
     [:span {:class (stl/css :token-copy)}
      [:span {:class (stl/css :token-name)} name]
      [:span {:class (stl/css :token-values)}
       [:span {:class (stl/css :token-value)} value-label]
       (when reference-label
         [:span {:class (stl/css :token-reference)}
          (str "(" reference-label ")")])]]]))

(mf/defc token-type-group*
  {::mf/private true}
  [{:keys [type tokens]}]
  (let [title (or (get-in dwta/token-properties [type :title])
                  (name type))]
    [:section {:class (stl/css :token-type-group)}
     [:div {:class (stl/css :token-type-title)}
      [:> icon* {:icon-id (token-group/token-section-icon type)
                 :size "s"}]
      [:span title]
      [:span {:class (stl/css :token-count)} (count tokens)]]
     [:div {:class (stl/css :token-list)}
      (for [token tokens]
        [:> token-item* {:key (str (:id token))
                         :token token}])]]))

(mf/defc tokens-section*
  [{:keys [file-id token-groups is-open]}]
  (let [token-count (reduce + 0 (map (comp count :tokens) token-groups))]
    [:> cmm/asset-section* {:file-id file-id
                            :title (tr "workspace.assets.tokens")
                            :section :tokens
                            :icon i/tokens
                            :assets-count token-count
                            :is-open is-open}
     [:> cmm/asset-section-block* {:role :content}
      [:div {:class (stl/css :token-groups)}
       (for [{:keys [type] :as group} token-groups]
         [:> token-type-group* {:key (name type)
                                :type type
                                :tokens (:tokens group)}])]]]))
