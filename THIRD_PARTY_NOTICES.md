# Third-party notices

This integration talks to the Google Assistant API (gRPC service
`google.assistant.embedded.v1alpha2.EmbeddedAssistant`) the way the projects
below do: the `Assist` call with one text query (`text_query`), the audio
output configuration, the dialog state (language, new conversation) and the
device configuration of the official text sample, and the broadcast phrases
per language. The two protobuf messages are encoded by hand in `src/proto.js`
from the field numbers of the `.proto` file; the rest is written in
JavaScript for this integration. No file is copied, and nothing of them is
installed at runtime.

## gassist_text

<https://github.com/tronikos/gassist_text>, version 0.1.0 (commit 29677af,
2026-11-08). Its `textinput.py` is itself a copy of the official sample
<https://github.com/googlesamples/assistant-sdk-python> (`textinput.py`).

```
Copyright (C) 2017 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Google Assistant API protocol buffers

`google/assistant/embedded/v1alpha2/embedded_assistant.proto`, from
<https://github.com/googleapis/googleapis> (as carried by gassist_text).

```
Copyright 2018 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Home Assistant, `google_assistant_sdk` integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/google_assistant_sdk>
(commit 0b7e2fa of `notify.py`, 2026-06-22): the table of broadcast phrases
per language (from Google's help page
<https://support.google.com/assistant/answer/9071582>) and the list of
supported language codes, in `src/constants.js`.

```
Copyright Home Assistant contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Runtime dependency

`@gladysassistant/integration-sdk` (Apache-2.0), installed from npm.
