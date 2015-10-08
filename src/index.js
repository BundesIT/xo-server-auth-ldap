/* eslint no-throw-literal: 0 */

import {promisify} from 'bluebird'
import eventToPromise from 'event-to-promise'
import {createClient} from 'ldapjs'
import {escape} from 'ldapjs/lib/filters/escape'
import {readFileSync} from 'fs'

// ===================================================================

const VAR_RE = /\{\{([^}]+)\}\}/g
function evalFilter (filter, vars) {
  return filter.replace(VAR_RE, (_, name) => {
    const value = vars[name]

    if (value === undefined) {
      throw new Error('invalid variable: ' + name)
    }

    return escape(value)
  })
}

export const configurationSchema = {
  type: 'object',
  properties: {
    uri: {
      description: 'URI of the LDAP server.',
      type: 'string'
    },
    certificateAuthorities: {
      description: `
Paths to CA certificates to use when connecting to SSL-secured LDAP servers.

If not specified, it will use a default set of well-known CAs.
`.trim(),
      type: 'array',
      items: {
        type: 'string'
      }
    },
    checkCertificate: {
      description: 'Check the validity of the server\'s certificates. Useful when connecting to servers that use a self-signed certificate.',
      type: 'boolean'
    },
    bind: {
      description: 'Credentials to use before looking for the user record.',
      type: 'object',
      properties: {
        dn: {
          description: `
Distinguished name of the user permitted to search the LDAP directory for the user to authenticate.

For Microsoft Active Directory, it can also be \`<user>@<domain>\`.
`.trim(),
          type: 'string'
        },
        password: {
          description: 'Password of the user permitted ot search the LDAP directory.',
          type: 'string'
        }
      },
      required: ['dn', 'password']
    },
    base: {
      description: 'The base is the part of the description tree where the users are looked for.',
      type: 'string'
    },
    filter: {
      description: `
Filter used to find the user.

For Microsoft Active Directory, you can try one of the following filters:

- \`(cn={{name}})\`
- \`(sAMAccountName={{name}})\`
- \`(sAMAccountName={{name}}@<domain>)\`
- \`(userPrincipalName={{name}})\`

Default is \`(uid={{name}})\`.
`.trim(),
      type: 'string'
    }
  },
  required: ['uri', 'base']
}

// ===================================================================

class AuthLdap {
  constructor (xo) {
    this._xo = xo
  }

  configure (conf) {
    const clientOpts = {
      url: conf.uri,
      maxConnections: 5,
      tlsOptions: {}
    }

    {
      const {
        bind,
        checkCertificate = true,
        certificateAuthorities
      } = conf

      if (bind) {
        clientOpts.bindDN = bind.dn
        clientOpts.bindCredentials = bind.password
      }

      const {tlsOptions} = clientOpts

      tlsOptions.rejectUnauthorized = checkCertificate
      if (certificateAuthorities) {
        // FIXME: should be async!!!
        tlsOptions.ca = certificateAuthorities.map(path => readFileSync(path))
      }
    }

    const {
      base: searchBase,
      filter: searchFilter = '(uid={{name}})'
    } = conf

    this._provider = async function ({username, password}) {
      if (username === undefined || password === undefined) {
        throw null
      }

      const client = createClient(clientOpts)

      try {
        // Promisify some methods.
        const bind = promisify(client.bind, client)
        const search = promisify(client.search, client)

        // Bind if necessary.
        {
          const {bind: credentials} = conf
          if (credentials) {
            await bind(credentials.dn, credentials.password)
          }
        }

        // Search for the user.
        const entries = []
        {
          const response = await search(searchBase, {
            scope: 'sub',
            filter: evalFilter(searchFilter, {
              name: username
            })
          })

          response.on('searchEntry', entry => {
            entries.push(entry.json)
          })

          const {status} = await eventToPromise(response, 'end')
          if (status) {
            throw new Error('unexpected search response status: ' + status)
          }
        }

        // Try to find an entry which can be bind with the given password.
        for (const entry of entries) {
          try {
            await bind(entry.objectName, password)
            return { username }
          } catch (_) {}
        }

        throw null
      } finally {
        client.unbind()
      }
    }
  }

  load () {
    this._xo.registerAuthenticationProvider(this._provider)
  }

  unload () {
    this._xo.unregisterAuthenticationProvider(this._provider)
  }
}

// ===================================================================

export default ({xo}) => new AuthLdap(xo)
