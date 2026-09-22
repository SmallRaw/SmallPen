;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.home-test
  (:require
   [app.main.smallpen.home :as home]
   [cljs.test :as t]))

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
