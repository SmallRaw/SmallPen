;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.options
  "SmallPen sections of the workspace design options panel."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.edit-policy :as dsep]
   [app.main.smallpen.token-inspector :as dseti]
   [app.main.smallpen.ui.refs :as sp-refs]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn properties-locked?
  "On the generated Design System page only source content is editable:
  generated decoration, or an empty selection, shows no property menus."
  [ds-page? shapes]
  (and ds-page?
       (or (empty? shapes)
           (some #(not (dsep/source-shape? %)) shapes))))

(mf/defc design-system-sections*
  "Explains editing on the Design System page and shows the Token Cell and
  component source inspectors for the selection."
  [{:keys [shapes file-id page-id]}]
  (let [ds-page? (mf/deref sp-refs/design-system-page?)]
    (when (smallpen/enabled?)
      [:*
       (when ds-page?
         [:section {:role "note" :class (stl/css :ds-editing-note)}
          [:h3 {:class (stl/css :ds-editing-title)}
           (tr "smallpen.design-system")]
          [:p {:class (stl/css :ds-editing-description)}
           (if (properties-locked? ds-page? shapes)
             (tr "smallpen.design-system.editing-note.select")
             (tr "smallpen.design-system.editing-note.write-back"))]])
       [:> dseti/token-section* {:shapes shapes
                                 :file-id file-id
                                 :page-id page-id}]
       [:> dseti/component-source-section* {:shapes shapes}]])))
