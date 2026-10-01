;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.sidebar.assets.media
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.workspace.media :as dwm]
   [app.main.smallpen :as smallpen]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.workspace.sidebar.assets.common :as cmm]
   [app.util.dom.dnd :as dnd]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn media-drop?
  "True for a drop of library Media dragged from the SmallPen assets panel."
  [event]
  (and (smallpen/enabled?)
       (dnd/has-type? event "text/asset-id")))

(defn drop-media!
  "Place the dropped library Media at `position` without copying its bytes."
  [event position]
  (let [id     (some-> (dnd/get-data event "text/asset-id") uuid/parse*)
        width  (js/parseFloat (dnd/get-data event "text/asset-width"))
        height (js/parseFloat (dnd/get-data event "text/asset-height"))]
    (when (and id (js/Number.isFinite width) (js/Number.isFinite height))
      (st/emit! (dwm/image-uploaded {:height height
                                     :id id
                                     :mtype (dnd/get-data event "text/asset-type")
                                     :name (dnd/get-data event "text/asset-name")
                                     :width width}
                                    position)))))

(mf/defc media-item*
  {::mf/private true}
  [{:keys [media]}]
  (let [{:keys [height id mtype name path width]} media
        dimensions (str width " × " height)
        metadata (if (seq path)
                   (str path " · " dimensions)
                   dimensions)
        on-drag-start
        (mf/use-fn
         (mf/deps height id mtype name width)
         (fn [event]
           (dnd/set-data! event "text/asset-id" (str id))
           (dnd/set-data! event "text/asset-name" name)
           (dnd/set-data! event "text/asset-type" mtype)
           (dnd/set-data! event "text/asset-width" (str width))
           (dnd/set-data! event "text/asset-height" (str height))
           (dnd/set-allowed-effect! event "copy")))
        on-double-click
        (mf/use-fn
         (mf/deps media)
         (fn [_]
           (st/emit! (dwm/place-library-media media))))
        on-key-down
        (mf/use-fn
         (mf/deps media)
         (fn [event]
           (when (contains? #{"Enter" " "} (.-key event))
             (.preventDefault event)
             (st/emit! (dwm/place-library-media media)))))]
    [:div {:aria-label (str name " " metadata " " mtype)
           :class (stl/css :media-item)
           :data-testid "smallpen-library-media"
           :draggable true
           :on-double-click on-double-click
           :on-drag-start on-drag-start
           :on-key-down on-key-down
           :role "button"
           :tab-index 0
           :title (str name "\n" metadata "\n" mtype)}
     [:img {:alt ""
            :class (stl/css :media-thumbnail)
            :draggable false
            :src (cf/resolve-file-media media true)}]
     [:span {:class (stl/css :media-copy)}
      [:span {:class (stl/css :media-name)} name]
      [:span {:class (stl/css :media-meta)} metadata]]]))

(mf/defc media-section*
  [{:keys [file-id is-open media]}]
  [:> cmm/asset-section* {:file-id file-id
                          :title (tr "workspace.assets.graphics")
                          :section :graphics
                          :icon i/graphics
                          :assets-count (count media)
                          :is-open is-open}
   [:> cmm/asset-section-block* {:role :content}
    [:div {:class (stl/css :media-list)}
     (for [item media]
       [:> media-item* {:key (str (:id item))
                        :media item}])]]])
