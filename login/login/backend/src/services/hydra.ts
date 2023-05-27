import { Configuration, OAuth2Api } from '@ory/client';
import axios from 'axios';

axios.defaults.headers.common['X-Forwarded-Proto'] = 'https'

// axios.interceptors.request.use(request => {
//   console.log('Starting Request', JSON.stringify(request, null, 2))
//   return request
// })

// axios.interceptors.response.use(response => {
//   console.log('Response:', JSON.stringify(response.data, null, 2))
//   return response
// })

const hydraAdminUrl = process.env.HYDRA_ADMIN_URL

export default new OAuth2Api(new Configuration({
  basePath: hydraAdminUrl,
}));
