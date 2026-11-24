{{- define "razzia.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 53 | trimSuffix "-" -}}
{{- end -}}

{{- define "razzia.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 53 | trimSuffix "-" -}}
{{- else if eq .Release.Name (include "razzia.name" .) -}}
{{- .Release.Name | trunc 53 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "razzia.name" .) | trunc 53 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "razzia.selectorLabels" -}}
app.kubernetes.io/name: {{ include "razzia.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "razzia.labels" -}}
{{ include "razzia.selectorLabels" . }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" | quote }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end -}}

{{- define "razzia.image" -}}
{{- $registry := required "Set image.registry to the repository prefix (including /razzia)" .root.Values.image.registry -}}
{{- $tag := required "Set image.tag to an immutable image tag" .root.Values.image.tag -}}
{{- printf "%s/%s:%s" (trimSuffix "/" $registry) .image $tag -}}
{{- end -}}

{{- define "razzia.validate" -}}
{{- $socket := .Values.apps.socket -}}
{{- if and $socket.hpa.enabled (gt (int $socket.hpa.minReplicas) (int $socket.hpa.maxReplicas)) -}}
{{- fail "apps.socket.hpa.minReplicas must not exceed maxReplicas" -}}
{{- end -}}
{{- if and $socket.hpa.enabled (not $socket.resources.requests.cpu) -}}
{{- fail "CPU autoscaling requires apps.socket.resources.requests.cpu" -}}
{{- end -}}
{{- $replicas := ternary (int $socket.hpa.minReplicas) (int $socket.replicas) $socket.hpa.enabled -}}
{{- if and $socket.pdb.enabled (ge (int $socket.pdb.minAvailable) $replicas) -}}
{{- fail "socket PDB minAvailable must be below the fixed replicas or HPA minReplicas to allow drains" -}}
{{- end -}}
{{- range $name, $app := .Values.apps -}}
{{- if ge (int $app.preStopSeconds) (int $app.terminationGracePeriodSeconds) -}}
{{- fail (printf "apps.%s.preStopSeconds must be below terminationGracePeriodSeconds" $name) -}}
{{- end -}}
{{- range $key, $_ := $app.env -}}
{{- if or (has $key (list "SOCKET_PORT" "CONFIG_PATH" "METRICS_PORT")) (has $key (list "DATABASE_URL" "REDIS_URL" "JWT_SECRET" "MANAGER_PASSWORD" "KAFKA_BROKERS")) -}}
{{- fail (printf "apps.%s.env.%s is managed by the chart or secretKeys" $name $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
