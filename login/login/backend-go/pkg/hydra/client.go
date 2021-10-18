package hydra

import (
	"net/url"

	"github.com/ory/hydra-client-go/client"
)

func GetAdminClient() (*client.OryHydra, error) {
	adminURL, err := url.Parse("https://hydra.localhost:4445")
	if err != nil {
		return nil, err
	}

	client := client.NewHTTPClientWithConfig(nil, &client.TransportConfig{Schemes: []string{adminURL.Scheme}, Host: adminURL.Host, BasePath: adminURL.Path})

	return client, nil
}

func GetPublicClient() (*client.OryHydra, error) {

	publicURL, err := url.Parse("https://hydra.localhost:4444")
	if err != nil {
		return nil, err
	}

	client := client.NewHTTPClientWithConfig(nil, &client.TransportConfig{Schemes: []string{publicURL.Scheme}, Host: publicURL.Host, BasePath: publicURL.Path})

	return client, nil
}
