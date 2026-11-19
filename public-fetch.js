'use strict';
// The small fetch surface used by this bridge. Private routes and redirects
// are refused before credentials can travel to an unexpected service.
const http = require('node:http');
const https = require('node:https');
const {assertPublicRoute, publicLookup} = require('./public-route');
module.exports = async function publicFetch(value, options = {}) {
  const url = assertPublicRoute(value);
  const signal = options.signal || AbortSignal.timeout(20000);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method || 'GET',
      headers: {...options.headers, ...(options.body !== undefined ? {'content-length': Buffer.byteLength(options.body)} : {})},
      lookup: publicLookup, signal,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume(); reject(new Error('service redirects are refused')); return;
      }
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){req.destroy(new Error('service response exceeds 1 MiB'));return;}chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8');
        resolve({status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,
          text:async()=>raw,json:async()=>JSON.parse(raw)});
      });
    });
    req.on('error',reject);
    if(options.body!==undefined)req.write(options.body);
    req.end();
  });
};
