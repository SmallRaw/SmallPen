;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.home-test
  (:require
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.home :as home]
   [app.util.i18n :refer [tr]]
   [cljs.test :as t]))

(t/deftest package-upload-keeps-directory-paths-and-omits-hidden-files
  (let [file (fn [path content]
               (let [value (js/File. #js [content] "manifest.json")]
                 (js/Object.defineProperty value "webkitRelativePath" #js {:value path})
                 value))
        form (smallpen/directory-upload-form
              [(file "Design.smallpen/manifest.json" "{}")
               (file "Design.smallpen/screens/main.json" "screen")
               (file "Design.smallpen/.DS_Store" "hidden")
               (file "Design.smallpen/.git/config" "hidden")])]
    (t/is (= 2 (.-length (js/Array.from (.entries form)))))
    (t/is (some? (.get form "Design.smallpen/manifest.json")))
    (t/is (some? (.get form "Design.smallpen/screens/main.json")))
    (t/is (nil? (.get form "Design.smallpen/.DS_Store")))
    (t/is (nil? (.get form "Design.smallpen/.git/config")))))

(t/deftest local-home-tolerates-a-recent-package-without-a-role
  (t/is (nil? (home/package-role-label nil))))

(t/deftest local-home-only-shows-loading-for-a-real-package-open
  (t/is (false? (home/package-opening? nil nil)))
  (t/is (true? (home/package-opening? "/tmp/product.smallpen"
                                      "/tmp/product.smallpen"))))

(t/deftest local-home-keeps-an-empty-recent-package-list-empty
  (t/is (empty? (home/package-items {:recentPackages []} {:packages []}))))

(t/deftest local-home-merges-recent-packages-with-open-session-state
  (t/is
   (= [{:active true
        :lastOpenedAt "2026-08-28T03:00:00.000Z"
        :locator "/tmp/product.smallpen"
        :name "Product"
        :open true
        :packageId "pkg_product"
        :role "product"
        :status {:state "ready"}}]
      (home/package-items
       {:recentPackages [{:lastOpenedAt "2026-08-28T03:00:00.000Z"
                          :locator "/tmp/product.smallpen"
                          :name "Product"
                          :packageId "pkg_product"
                          :role "product"}]}
       {:packages [{:active true
                    :packageId "pkg_product"
                    :status {:state "ready"}}]}))))

(t/deftest local-home-routing-notices-follow-the-ui-language
  (t/is (= (tr "smallpen.home.notice.file-not-found")
           (home/notice-message {:code "file_not_found"})))
  (t/is (= (tr "smallpen.home.notice.file-identity-mismatch")
           (home/notice-message {:code "file_identity_mismatch"})))
  (t/is (= (tr "smallpen.home.notice.link-unavailable")
           (home/notice-message {:code "file_unavailable"}))))
