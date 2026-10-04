'use strict';



const fs = require('fs');
const path = require('path');

let dotenv;
try {
  dotenv = require('dotenv');
} catch {
  dotenv = null;          // not installed: fall through to the real environment
}

if (dotenv) {
  for (const file of [
    path.join(__dirname, '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
  ]) {
    let parsed;
    try {
      parsed = dotenv.parse(fs.readFileSync(file));
    } catch {
      continue;                 // file absent: nothing to load from it
    }
    for (const [key, value] of Object.entries(parsed)) {
      // An empty `KEY=` copied from .env.example means "not filled in", not
      // "set to empty": it must not hide a real value in the next file.
      if (value === '') continue;
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
    }
  }
}
