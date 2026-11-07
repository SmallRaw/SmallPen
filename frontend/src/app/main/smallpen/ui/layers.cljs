;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.layers
  "Badges that mark generated SmallPen Design System content in the layer
  tree and the page list."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.smallpen :as smallpen]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn- layer-badge-kind
  "The projection writes flat `design-system*` markers on generated shapes."
  [shape]
  (when (smallpen/enabled?)
    (let [mode (get-in shape [:plugin-data :smallpen "design-system"])
          kind (get-in shape [:plugin-data :smallpen "design-system-kind"])]
      (cond
        (= kind "token-cell") :token
        (= mode "source") :source
        (= mode "decoration") :decoration))))

(mf/defc design-system-badge*
  "Marks which layer rows map to real source objects and which are
  generated decoration. Renders nothing for ordinary shapes."
  [{:keys [shape]}]
  (when-let [kind (layer-badge-kind shape)]
    [:span {:class (stl/css :badge)
            :data-testid (case kind
                           :token "dse-token-specimen"
                           :source "dse-source"
                           :decoration "dse-decoration")}
     (case kind
       :token (tr "smallpen.design-system.badge.token")
       :source (tr "smallpen.design-system.badge.source")
       :decoration (tr "smallpen.design-system.badge.decoration"))]))

(mf/defc design-system-page-badge*
  "Marks the generated Design System page in the page list."
  [{:keys [page]}]
  (when (and (smallpen/enabled?)
             (some-> page :plugin-data :smallpen (get "design-system-page")))
    [:span {:class (stl/css :badge :page-badge)
            :data-testid "dse-page-badge"}
     (tr "smallpen.design-system.badge.page")]))

(defn skip-page-rename?
  "SmallPen refuses renames of generated Design System pages, so a blur
  without an edit must not commit one. Penpot always commits the rename."
  [old-name new-name]
  (and (smallpen/enabled?)
       (= old-name new-name)))
