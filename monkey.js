var rest = require('restler');
var pg = require('pg');
var Q = require('node-promise');
var url = require('url');

var parseConnectionString = function(str) {
  //unix socket
  if(str.charAt(0) === '/') {
    return { host: str };
  }
  var result = url.parse(str);
  var config = {};
  config.host = result.hostname;
  config.database = result.pathname ? result.pathname.slice(1) : null
  var auth = (result.auth || ':').split(':');
  config.user = auth[0];
  config.password = auth[1];
  config.port = result.port;
  return config;
};

var db = {config: parseConnectionString(process.env.DATABASE_URL)};
db.config.ssl = true;
db.do_query = function (query, callback) {
    pg.connect(this.config, function (err, client) {
        client.query(query, callback);
    },
    function (error) {
        throw error;
    });
};

var check = function (id) {
    var promise = Q.defer();

    db.do_query({
        text: 'SELECT COUNT(*) AS count FROM records WHERE id = $1',
        values: [id]
    }, function (err, result) {
        if (err) throw err;
        promise.resolve(result.rows[0].count != 0);
    });

    return promise;
};


var insert = function (id) {
    db.do_query({
        text: 'INSERT INTO records (id) VALUES($1)',
        values: [id]
    }, function (err, result) {
        if (err) throw err;
    });
};

Twilio = rest.service(function(u, p) {
    this.defaults.username = u;
    this.defaults.password = p;
}, {
    baseURL: 'https://api.twilio.com'
}, {
});
var twilio_client = new Twilio(process.env.TWILIO_USERNAME, process.env.TWILIO_PASSWORD);

var token_promise = Q.defer();
rest.post('https://api.soundcloud.com/oauth2/token', {
    data: {
        'client_id': process.env.SC_CLIENT_ID,
        'client_secret': process.env.SC_CLIENT_SECRET,
        'username': process.env.SC_USERNAME,
        'password': process.env.SC_PASSWORD,
        'grant_type': 'password',
        'scope': ''
    }
}).on('complete', function(data) {
    console.log("Obtained access token for SoundCloud");
    token_promise.resolve(data.access_token);
});

var recordings_promise = Q.defer();
twilio_client.get('/2010-04-01/Accounts/' + process.env.TWILIO_USERNAME + '/Recordings.json')
.on('complete', function (result, response) {
    console.log("Obtained list of recordings");
    recordings_promise.resolve(result.recordings);
});

token_promise.then(function (access_token) {
    recordings_promise.then(function (recordings) {
        Q.all(recordings.map(function (rec) {
            var return_promise = Q.defer();
            check(rec.call_sid).then(function (haveit) {
                if (haveit) {
                    console.log(rec.call_sid + " is old");
                    return_promise.resolve();
                } else {
                    console.log(rec.call_sid + " is new, getting MP3");

                    var mp3_promise = Q.defer();
                    twilio_client.get(rec.uri.replace('.json', '.mp3'))
                    .on('complete', function (result, response) {
                        console.log('Got MP3 for ' + rec.call_sid);
                        mp3_promise.resolve(response.raw);
                    });

                    mp3_promise.then(function (mp3) {
                        console.log('Uploading ' + rec.call_sid + ' to SoundCloud');
                        rest.post('https://api.soundcloud.com/me/tracks.json', {
                            multipart: true,
                            data: {
                                'track[title]': rec.call_sid,
                                'track[sharing]': 'public',
                                'track[asset_data]': rest.data(rec.call_sid, 'audio/mpeg3', mp3),
                                'oauth_token': access_token
                            }
                        }).on('complete', function (result, response) {
                            if (result instanceof Error) {
                                console.log(result.stack);
                            } else if (response.statusCode > 300) {
                                console.log(response);
                                console.log(result);
                            } else {
                                console.log(rec.call_sid + ' stored at ' + result.permalink_url);
                                insert(rec.call_sid);
                            }
                            return_promise.resolve();
                        });
                    });
                }
            });

            return return_promise;
        })
        ).then(function (results) {
            pg.end();
        });
    });
});
