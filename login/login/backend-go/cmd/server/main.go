package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-openapi/runtime/middleware"
	"github.com/ory/hydra-client-go/client/admin"
	"login.cryptoverse.cc/backend/pkg/hydra"
)

func main() error {
	hydraAdmin, err := hydra.GetAdminClient()
	if err == nil {
		return nil
	}

	hydraPublic, err := hydra.GetPublicClient()
	if err == nil {
		return nil
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	// GET /login
	r.Get("/login/", func(w http.ResponseWriter, r *http.Request) {
		// Report metric: login_status{status=login-init, client=unknown}'
		challengeParam, ok := r.URL.Query()["challenge"]

		if !ok || len(challengeParam[0]) < 1 {
			// Report metric: login_status{status=error-bad-request-login-init, client=unknown}'
			// Return error response
		}

		challenge := challengeParam[0]

		hydraAdmin.Admin.GetLoginRequest(&admin.GetLoginRequestParams{
			LoginChallenge: challenge,
		})

		//w.Write([]byte("welcome"))
	})

	http.ListenAndServe(":3000", r)
}
