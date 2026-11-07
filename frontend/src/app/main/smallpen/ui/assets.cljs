;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.assets
  "SmallPen adjustments to the workspace assets sidebar."
  (:require
   [app.main.data.style-dictionary :as sd]
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.token-state :as spts]
   [app.main.ui.workspace.sidebar.assets.common :as cmm]
   [app.main.ui.workspace.sidebar.assets.tokens-data :as tokens-data]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn section-filter-options
  "SmallPen packages hold graphics instead of library colors, so the
  assets filter offers Graphics where Penpot offers Colors."
  [options]
  (mapv (fn [{:keys [id handler] :as option}]
          (if (= "colors" id)
            {:name    (tr "workspace.assets.graphics")
             :id      "graphics"
             :handler handler}
            option))
        options))

(defn use-library-extras
  "Hook with the assets a SmallPen library card lists besides Penpot's:
  filtered media, and the active Tokens of linked (non-local) libraries.
  Both stay empty outside SmallPen."
  [library filters is-local]
  (let [smallpen?    (smallpen/enabled?)
        media        (:media library)
        tokens-lib   (:tokens-lib library)
        show-tokens? (and smallpen? (not is-local))

        active-tokens
        (mf/with-memo [tokens-lib show-tokens?]
          (if (and show-tokens? tokens-lib)
            (spts/get-tokens-in-active-sets tokens-lib)
            {}))

        resolved-tokens
        (sd/use-resolved-tokens* active-tokens)

        filtered-media
        (mf/with-memo [filters media smallpen?]
          (if smallpen?
            (cmm/apply-filters (vals media) filters)
            []))

        token-groups
        (mf/with-memo [active-tokens resolved-tokens filters]
          (tokens-data/library-token-groups active-tokens
                                            resolved-tokens
                                            filters))]
    {:media filtered-media
     :token-groups token-groups}))
