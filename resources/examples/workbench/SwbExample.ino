#include <Arduino.h>
#include <string.h>

namespace {
const char request[] = "READ";
char line[sizeof(request)];
size_t length = 0;
bool tooLong = false;
}

void setup() {
  Serial.begin(115200);
}

void loop() {
  while (Serial.available() > 0) {
    const int byte = Serial.read();
    if (byte == '\n') {
      const size_t requestLength = sizeof(request) - 1;
      const bool complete = length == requestLength ||
          (length == sizeof(line) && line[requestLength] == '\r');
      if (!tooLong && complete && memcmp(line, request, requestLength) == 0) {
        Serial.print("3.250\r\n");
      }
      length = 0;
      tooLong = false;
    } else if (length < sizeof(line)) {
      line[length++] = static_cast<char>(byte);
    } else {
      tooLong = true;
    }
  }
}

