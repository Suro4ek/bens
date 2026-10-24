import type { ResourceInfo } from "./api";
import { navId } from "./nav";

/**
 * Starting YAML for "+" on a resource list. `NAMESPACE` is replaced with the
 * namespace the list is filtered to (or `default`).
 */
const TEMPLATES: Record<string, string> = {
  "/pods": `apiVersion: v1
kind: Pod
metadata:
  name: example
  namespace: NAMESPACE
spec:
  containers:
    - name: main
      image: nginx:1.27
      ports:
        - containerPort: 80
`,
  "apps/deployments": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  namespace: NAMESPACE
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: main
          image: nginx:1.27
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
`,
  "apps/statefulsets": `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: example
  namespace: NAMESPACE
spec:
  serviceName: example
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: main
          image: nginx:1.27
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 1Gi
`,
  "apps/daemonsets": `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: example
  namespace: NAMESPACE
spec:
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: main
          image: busybox:1.36
          command: [sh, -c, "sleep infinity"]
`,
  "batch/jobs": `apiVersion: batch/v1
kind: Job
metadata:
  name: example
  namespace: NAMESPACE
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: main
          image: busybox:1.36
          command: [sh, -c, "echo hello"]
`,
  "batch/cronjobs": `apiVersion: batch/v1
kind: CronJob
metadata:
  name: example
  namespace: NAMESPACE
spec:
  schedule: "*/15 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: main
              image: busybox:1.36
              command: [sh, -c, "date"]
`,
  "/services": `apiVersion: v1
kind: Service
metadata:
  name: example
  namespace: NAMESPACE
spec:
  type: ClusterIP
  selector:
    app: example
  ports:
    - name: http
      port: 80
      targetPort: 80
`,
  "networking.k8s.io/ingresses": `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example
  namespace: NAMESPACE
spec:
  rules:
    - host: example.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: example
                port:
                  number: 80
`,
  "networking.k8s.io/networkpolicies": `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: example
  namespace: NAMESPACE
spec:
  podSelector:
    matchLabels:
      app: example
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {}
`,
  "/persistentvolumeclaims": `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example
  namespace: NAMESPACE
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
`,
  "/serviceaccounts": `apiVersion: v1
kind: ServiceAccount
metadata:
  name: example
  namespace: NAMESPACE
`,
  "/namespaces": `apiVersion: v1
kind: Namespace
metadata:
  name: example
`,
  "/resourcequotas": `apiVersion: v1
kind: ResourceQuota
metadata:
  name: example
  namespace: NAMESPACE
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "50"
`,
  "/limitranges": `apiVersion: v1
kind: LimitRange
metadata:
  name: example
  namespace: NAMESPACE
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
`,
  "autoscaling/horizontalpodautoscalers": `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: example
  namespace: NAMESPACE
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
`,
  "policy/poddisruptionbudgets": `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example
  namespace: NAMESPACE
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: example
`,
  "rbac.authorization.k8s.io/roles": `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: example
  namespace: NAMESPACE
rules:
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, watch]
`,
  "rbac.authorization.k8s.io/rolebindings": `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: example
  namespace: NAMESPACE
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: example
subjects:
  - kind: ServiceAccount
    name: example
    namespace: NAMESPACE
`,
  "rbac.authorization.k8s.io/clusterroles": `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: example
rules:
  - apiGroups: [""]
    resources: [namespaces]
    verbs: [get, list, watch]
`,
  "rbac.authorization.k8s.io/clusterrolebindings": `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: example
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: example
subjects:
  - kind: ServiceAccount
    name: example
    namespace: default
`,
};

/** YAML to start from when creating a resource of this type. */
export function templateFor(resource: ResourceInfo, namespace: string | null): string {
  const ns = namespace ?? "default";
  const known = TEMPLATES[navId(resource)];
  if (known) return known.replaceAll("NAMESPACE", ns);
  const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;
  return `apiVersion: ${apiVersion}
kind: ${resource.kind}
metadata:
  name: example
${resource.namespaced ? `  namespace: ${ns}\n` : ""}spec: {}
`;
}
